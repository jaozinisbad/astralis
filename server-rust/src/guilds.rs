use std::{collections::HashMap, sync::Arc};

use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, FromRequestParts, Path, State},
    http::{StatusCode, request::Parts},
    routing::{delete, get, post},
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use socketioxide::SocketIo;
use sqlx::{PgExecutor, PgPool, Postgres, Transaction};

use super::{ApiError, AppState, Session, authenticate_http, serialize_timestamp};

const PERMISSIONS: [&str; 7] = [
    "gerenciar_servidor",
    "gerenciar_canais",
    "gerenciar_cargos",
    "gerenciar_membros",
    "banir_membros",
    "expulsar_call",
    "gerenciar_mensagens",
];
const NOT_MEMBER: ApiError = ApiError(StatusCode::FORBIDDEN, "Você não é membro deste servidor.");
const GUILD_NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "Servidor não encontrado.");
const CHANNEL_NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "Canal não encontrado.");
const ROLE_NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "Cargo não encontrado.");
const MANAGE_ROLES_FORBIDDEN: ApiError =
    ApiError(StatusCode::FORBIDDEN, "Você não pode gerenciar cargos.");
const MANAGE_CHANNELS_FORBIDDEN: ApiError = ApiError(
    StatusCode::FORBIDDEN,
    "Você não tem permissão para gerenciar canais.",
);

type DbTransaction = Transaction<'static, Postgres>;
type ApiResult<T> = Result<T, ApiError>;

pub(crate) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/servidores", get(list_guilds).post(create_guild))
        .route("/api/servidores/entrar", post(join_guild))
        .route(
            "/api/servidores/{guild}",
            delete(delete_guild).patch(update_guild),
        )
        .route("/api/servidores/{guild}/sair", post(leave_guild))
        .route(
            "/api/servidores/{guild}/cargos",
            get(list_roles).post(create_role),
        )
        .route(
            "/api/servidores/{guild}/cargos/{role}",
            axum::routing::patch(update_role),
        )
        .route("/api/servidores/{guild}/membros", get(list_members))
        .route(
            "/api/servidores/{guild}/membros/{member}",
            delete(kick_member),
        )
        .route(
            "/api/servidores/{guild}/membros/{member}/banir",
            post(ban_member),
        )
        .route(
            "/api/servidores/{guild}/membros/{member}/cargos/{role}",
            post(assign_role).delete(unassign_role),
        )
        .route(
            "/api/servidores/{guild}/canais",
            get(list_channels).post(create_channel),
        )
        .route(
            "/api/servidores/{guild}/canais/{channel}",
            delete(delete_channel),
        )
        .route("/api/canais/{channel}/mensagens", get(channel_history))
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
}

struct Authenticated(Session);

impl FromRequestParts<Arc<AppState>> for Authenticated {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &Arc<AppState>) -> ApiResult<Self> {
        authenticate_http(state, &parts.headers).await.map(Self)
    }
}

pub(crate) async fn is_member(
    db: &PgPool,
    server_id: i64,
    user_id: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM membros_servidor WHERE servidor_id = $1 AND usuario_id = $2)",
    )
    .bind(server_id)
    .bind(user_id)
    .fetch_one(db)
    .await
}

pub(crate) async fn has_permission(
    db: &PgPool,
    server_id: i64,
    user_id: i64,
    permission: &str,
) -> Result<bool, sqlx::Error> {
    permission_query(db, server_id, user_id, permission).await
}

async fn permission_query<'e>(
    db: impl PgExecutor<'e>,
    server_id: i64,
    user_id: i64,
    permission: &str,
) -> Result<bool, sqlx::Error> {
    let member: Option<(String, Value)> = sqlx::query_as(
        "SELECT m.papel, COALESCE(jsonb_agg(c.permissoes) FILTER (WHERE c.id IS NOT NULL), '[]')
         FROM membros_servidor m
         LEFT JOIN membros_cargos mc ON mc.servidor_id = m.servidor_id AND mc.usuario_id = m.usuario_id
         LEFT JOIN cargos c ON c.id = mc.cargo_id AND c.servidor_id = m.servidor_id
         WHERE m.servidor_id = $1 AND m.usuario_id = $2
         GROUP BY m.papel",
    )
    .bind(server_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(member.is_some_and(|(role, permissions)| {
        role == "dono"
            || match permissions {
                Value::Array(entries) => entries
                    .into_iter()
                    .any(|entry| stored_permissions(entry)[permission].as_bool() == Some(true)),
                _ => false,
            }
    }))
}

// Serializes guild changes so a membership change and its role cleanup cannot interleave.
async fn lock_guild(db: &PgPool, guild: i64) -> ApiResult<(DbTransaction, Option<i64>)> {
    let mut tx = db.begin().await.map_err(ApiError::internal)?;
    let owner = sqlx::query_scalar("SELECT dono_id FROM servidores WHERE id = $1 FOR UPDATE")
        .bind(guild)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    Ok((tx, owner))
}

async fn managed_guild(
    db: &PgPool,
    guild: i64,
    user: i64,
    permission: &str,
    forbidden: ApiError,
) -> ApiResult<DbTransaction> {
    let (mut tx, owner) = lock_guild(db, guild).await?;
    if owner.is_none()
        || !permission_query(&mut *tx, guild, user, permission)
            .await
            .map_err(ApiError::internal)?
    {
        return Err(forbidden);
    }
    Ok(tx)
}

async fn require_member(db: &PgPool, guild: i64, user: i64) -> ApiResult<()> {
    is_member(db, guild, user)
        .await
        .map_err(ApiError::internal)?
        .then_some(())
        .ok_or(NOT_MEMBER)
}

fn normalize_permissions(input: &Value) -> Value {
    Value::Object(
        PERMISSIONS
            .iter()
            .map(|&name| (name.to_owned(), json!(input[name].as_bool() == Some(true))))
            .collect(),
    )
}

fn stored_permissions(input: Value) -> Value {
    match input {
        Value::String(text) => serde_json::from_str(&text).unwrap_or_else(|_| json!({})),
        Value::Null => json!({}),
        _ => input,
    }
}

fn invite_code() -> ApiResult<String> {
    let mut bytes = [0; 4];
    getrandom::fill(&mut bytes).map_err(ApiError::internal)?;
    Ok(format!("{:08x}", u32::from_be_bytes(bytes)))
}

async fn create_guild(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Json(input): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = input["nome"].as_str().unwrap_or_default().trim();
    if name.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Dê um nome para o servidor.",
        ));
    }
    let mut tx = state.db.begin().await.map_err(ApiError::internal)?;
    let (guild, code): (i64, String) = loop {
        let code = invite_code()?;
        let guild = sqlx::query_scalar(
            "INSERT INTO servidores (nome, dono_id, codigo_convite) VALUES ($1, $2, $3)
             ON CONFLICT (codigo_convite) DO NOTHING RETURNING id",
        )
        .bind(name)
        .bind(user.id)
        .bind(&code)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        if let Some(guild) = guild {
            break (guild, code);
        }
    };
    sqlx::query(
        "INSERT INTO membros_servidor (servidor_id, usuario_id, papel) VALUES ($1, $2, 'dono')",
    )
    .bind(guild)
    .bind(user.id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO canais (servidor_id, nome, tipo)
         VALUES ($1, 'geral', 'texto'), ($1, 'Sala de voz', 'voz')",
    )
    .bind(guild)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let permissions = Value::Object(
        PERMISSIONS
            .iter()
            .map(|&name| (name.into(), json!(true)))
            .collect(),
    );
    let role: i64 = sqlx::query_scalar(
        "INSERT INTO cargos (servidor_id, nome, cor, permissoes, posicao)
         VALUES ($1, 'Administrador', '#e74c3c', $2, 100) RETURNING id",
    )
    .bind(guild)
    .bind(permissions)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO membros_cargos (cargo_id, servidor_id, usuario_id) VALUES ($1, $2, $3)",
    )
    .bind(role)
    .bind(guild)
    .bind(user.id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": guild, "nome": name, "codigo_convite": code, "icone_url": null, "banner_url": null
        })),
    ))
}

#[derive(Serialize, sqlx::FromRow)]
struct GuildSummary {
    id: i64,
    nome: String,
    codigo_convite: String,
    icone_url: Option<String>,
    banner_url: Option<String>,
    descricao: Option<String>,
    papel: String,
}

async fn list_guilds(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
) -> ApiResult<Json<Vec<GuildSummary>>> {
    sqlx::query_as(
        "SELECT s.id, s.nome, s.codigo_convite, s.icone_url, s.banner_url, s.descricao, m.papel
         FROM servidores s JOIN membros_servidor m ON m.servidor_id = s.id
         WHERE m.usuario_id = $1 ORDER BY s.id",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await
    .map(Json)
    .map_err(ApiError::internal)
}

async fn join_guild(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Json(input): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let code = input["codigo"].as_str().unwrap_or_default().trim();
    if code.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Informe um código de convite.",
        ));
    }
    let mut tx = state.db.begin().await.map_err(ApiError::internal)?;
    let (guild, name): (i64, String) =
        sqlx::query_as("SELECT id, nome FROM servidores WHERE codigo_convite = $1 FOR UPDATE")
            .bind(code)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::internal)?
            .ok_or(ApiError(
                StatusCode::NOT_FOUND,
                "Código de convite inválido.",
            ))?;
    let (member, banned): (bool, bool) = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM membros_servidor WHERE servidor_id = $1 AND usuario_id = $2),
                EXISTS (SELECT 1 FROM banimentos_servidor WHERE servidor_id = $1 AND usuario_id = $2)",
    )
    .bind(guild)
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if member {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "Você já é membro deste servidor.",
        ));
    }
    if banned {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Você foi banido deste servidor.",
        ));
    }
    clear_member_roles(&mut tx, guild, user.id).await?;
    sqlx::query("INSERT INTO membros_servidor (servidor_id, usuario_id) VALUES ($1, $2)")
        .bind(guild)
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": guild, "nome": name })),
    ))
}

async fn delete_guild(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Extension(io): Extension<SocketIo>,
    Path(guild): Path<i64>,
) -> ApiResult<StatusCode> {
    let (mut tx, owner) = lock_guild(&state.db, guild).await?;
    if owner.ok_or(GUILD_NOT_FOUND)? != user.id {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Só quem criou o servidor pode excluí-lo.",
        ));
    }
    let channels: Vec<i64> = sqlx::query_scalar("SELECT id FROM canais WHERE servidor_id = $1")
        .bind(guild)
        .fetch_all(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    sqlx::query("DELETE FROM servidores WHERE id = $1")
        .bind(guild)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    for channel in channels {
        crate::realtime::remove_channel_access(&io, &state, channel).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
struct GuildDetails {
    id: i64,
    nome: String,
    descricao: Option<String>,
    icone_url: Option<String>,
    banner_url: Option<String>,
}

fn field_text(input: &Value) -> String {
    input
        .as_str()
        .map_or_else(|| input.to_string(), str::to_owned)
}

fn trimmed_field(input: &Value, name: &str, current: &str) -> String {
    input.get(name).map_or_else(
        || current.to_owned(),
        |value| field_text(value).trim().to_owned(),
    )
}

fn image_field(input: &Value, name: &str, current: Option<String>) -> ApiResult<Option<String>> {
    let image = match input.get(name) {
        None => current,
        Some(Value::Null | Value::Bool(false)) => None,
        Some(Value::Number(number)) if number.as_f64() == Some(0.0) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(value) => Some(field_text(value)),
    };
    if image.as_deref().is_some_and(|text| {
        !text.starts_with("data:image/") || text.encode_utf16().count() > 2_000_000
    }) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Imagem do servidor inválida ou muito grande.",
        ));
    }
    Ok(image)
}

async fn update_guild(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Path(guild): Path<i64>,
    Json(input): Json<Value>,
) -> ApiResult<Json<GuildDetails>> {
    let mut tx = managed_guild(
        &state.db,
        guild,
        user.id,
        "gerenciar_servidor",
        ApiError(
            StatusCode::FORBIDDEN,
            "Você não tem permissão para editar este servidor.",
        ),
    )
    .await?;
    let current: GuildDetails = sqlx::query_as(
        "SELECT id, nome, descricao, icone_url, banner_url FROM servidores WHERE id = $1",
    )
    .bind(guild)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let name = trimmed_field(&input, "nome", &current.nome);
    let description = trimmed_field(
        &input,
        "descricao",
        current.descricao.as_deref().unwrap_or_default(),
    );
    if name.is_empty()
        || name.encode_utf16().count() > 80
        || description.encode_utf16().count() > 240
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Nome ou descrição do servidor inválidos.",
        ));
    }
    let icon = image_field(&input, "icone_url", current.icone_url)?;
    let banner = image_field(&input, "banner_url", current.banner_url)?;
    let updated = GuildDetails {
        id: guild,
        nome: name,
        descricao: (!description.is_empty()).then_some(description),
        icone_url: icon,
        banner_url: banner,
    };
    sqlx::query("UPDATE servidores SET nome = $1, descricao = $2, icone_url = $3, banner_url = $4 WHERE id = $5")
        .bind(&updated.nome)
        .bind(&updated.descricao)
        .bind(&updated.icone_url)
        .bind(&updated.banner_url)
        .bind(guild)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(updated))
}

#[derive(Serialize, sqlx::FromRow)]
struct Role {
    id: i64,
    nome: String,
    cor: String,
    permissoes: Value,
    posicao: i32,
}

async fn list_roles(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Path(guild): Path<i64>,
) -> ApiResult<Json<Vec<Role>>> {
    require_member(&state.db, guild, user.id).await?;
    let mut roles: Vec<Role> = sqlx::query_as(
        "SELECT id, nome, cor, permissoes, posicao FROM cargos WHERE servidor_id = $1 ORDER BY posicao DESC, id",
    )
    .bind(guild)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    for role in &mut roles {
        role.permissoes = stored_permissions(std::mem::take(&mut role.permissoes));
    }
    Ok(Json(roles))
}

fn validate_role(name: &str, color: &str) -> ApiResult<()> {
    let valid_color = color
        .strip_prefix('#')
        .is_some_and(|hex| hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if name.is_empty() || name.encode_utf16().count() > 32 || !valid_color {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Nome ou cor do cargo inválidos.",
        ));
    }
    Ok(())
}

async fn create_role(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Path(guild): Path<i64>,
    Json(input): Json<Value>,
) -> ApiResult<(StatusCode, Json<Role>)> {
    let mut tx = managed_guild(
        &state.db,
        guild,
        user.id,
        "gerenciar_cargos",
        MANAGE_ROLES_FORBIDDEN,
    )
    .await?;
    let name = input["nome"].as_str().unwrap_or_default().trim();
    let color = input["cor"]
        .as_str()
        .filter(|color| !color.is_empty())
        .unwrap_or("#99aab5")
        .trim();
    validate_role(name, color)?;
    let permissions = normalize_permissions(&input["permissoes"]);
    let position = input["posicao"]
        .as_f64()
        .or_else(|| input["posicao"].as_str()?.trim().parse().ok())
        .unwrap_or(0.0);
    if !position.is_finite()
        || position.fract() != 0.0
        || position < f64::from(i32::MIN)
        || position > f64::from(i32::MAX)
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Posição do cargo inválida.",
        ));
    }
    let role = sqlx::query_as(
        "INSERT INTO cargos (servidor_id, nome, cor, permissoes, posicao) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, nome, cor, permissoes, posicao",
    )
    .bind(guild)
    .bind(name)
    .bind(color)
    .bind(permissions)
    .bind(position as i32)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok((StatusCode::CREATED, Json(role)))
}

async fn update_role(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Path((guild, role)): Path<(i64, i64)>,
    Json(input): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut tx = managed_guild(
        &state.db,
        guild,
        user.id,
        "gerenciar_cargos",
        MANAGE_ROLES_FORBIDDEN,
    )
    .await?;
    let current: Role = sqlx::query_as(
        "SELECT id, nome, cor, permissoes, posicao FROM cargos WHERE id = $1 AND servidor_id = $2",
    )
    .bind(role)
    .bind(guild)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?
    .ok_or(ROLE_NOT_FOUND)?;
    let name = trimmed_field(&input, "nome", &current.nome);
    let color = trimmed_field(&input, "cor", &current.cor);
    validate_role(&name, &color)?;
    let permissions = match input.get("permissoes") {
        Some(input) => normalize_permissions(input),
        None => stored_permissions(current.permissoes),
    };
    sqlx::query(
        "UPDATE cargos SET nome = $1, cor = $2, permissoes = $3 WHERE id = $4 AND servidor_id = $5",
    )
    .bind(&name)
    .bind(&color)
    .bind(&permissions)
    .bind(role)
    .bind(guild)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(
        json!({ "id": role, "nome": name, "cor": color, "permissoes": permissions }),
    ))
}

async fn assign_role(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Path((guild, member, role)): Path<(i64, i64, i64)>,
) -> ApiResult<StatusCode> {
    let mut tx = managed_guild(
        &state.db,
        guild,
        user.id,
        "gerenciar_cargos",
        MANAGE_ROLES_FORBIDDEN,
    )
    .await?;
    let allowed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM cargos WHERE id = $1 AND servidor_id = $2)
          AND EXISTS (SELECT 1 FROM membros_servidor WHERE servidor_id = $2 AND usuario_id = $3)",
    )
    .bind(role)
    .bind(guild)
    .bind(member)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if !allowed {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Cargo ou membro não encontrado.",
        ));
    }
    sqlx::query(
        "INSERT INTO membros_cargos (cargo_id, servidor_id, usuario_id) VALUES ($1, $2, $3)
         ON CONFLICT (cargo_id, usuario_id) DO NOTHING",
    )
    .bind(role)
    .bind(guild)
    .bind(member)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unassign_role(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Path((guild, member, role)): Path<(i64, i64, i64)>,
) -> ApiResult<StatusCode> {
    let mut tx = managed_guild(
        &state.db,
        guild,
        user.id,
        "gerenciar_cargos",
        MANAGE_ROLES_FORBIDDEN,
    )
    .await?;
    sqlx::query(
        "DELETE FROM membros_cargos WHERE servidor_id = $1 AND usuario_id = $2 AND cargo_id = $3",
    )
    .bind(guild)
    .bind(member)
    .bind(role)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(sqlx::FromRow)]
struct MemberRow {
    usuario_id: i64,
    nome: String,
    papel: String,
    avatar_cor: String,
    avatar_url: Option<String>,
    status: String,
    cargo_id: Option<i64>,
    cargo_nome: Option<String>,
    cargo_cor: Option<String>,
}

#[derive(Serialize)]
struct RoleSummary {
    id: i64,
    nome: String,
    cor: String,
}

#[derive(Serialize)]
struct Member {
    id: i64,
    nome: String,
    papel: String,
    avatar_cor: String,
    avatar_url: Option<String>,
    status: String,
    cargos: Vec<RoleSummary>,
    online: bool,
}

async fn list_members(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Extension(io): Extension<SocketIo>,
    Path(guild): Path<i64>,
) -> ApiResult<Json<Vec<Member>>> {
    require_member(&state.db, guild, user.id).await?;
    let rows: Vec<MemberRow> = sqlx::query_as(
        "SELECT m.usuario_id, m.papel, u.nome, u.avatar_cor, u.avatar_url, u.status,
                c.id AS cargo_id, c.nome AS cargo_nome, c.cor AS cargo_cor
         FROM membros_servidor m JOIN usuarios u ON u.id = m.usuario_id
         LEFT JOIN membros_cargos mc ON mc.servidor_id = m.servidor_id AND mc.usuario_id = m.usuario_id
         LEFT JOIN cargos c ON c.id = mc.cargo_id AND c.servidor_id = m.servidor_id
         WHERE m.servidor_id = $1
         ORDER BY CASE WHEN m.papel = 'dono' THEN 0 ELSE 1 END, c.posicao DESC NULLS LAST, u.nome",
    )
    .bind(guild)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    let mut members = Vec::new();
    let mut positions = HashMap::new();
    for row in rows {
        let position = *positions.entry(row.usuario_id).or_insert_with(|| {
            let position = members.len();
            members.push(Member {
                id: row.usuario_id,
                nome: row.nome,
                papel: row.papel,
                avatar_cor: row.avatar_cor,
                avatar_url: row.avatar_url,
                status: row.status,
                cargos: Vec::new(),
                online: !io
                    .to(format!("user-{}", row.usuario_id))
                    .sockets()
                    .is_empty(),
            });
            position
        });
        if let (Some(id), Some(nome), Some(cor)) = (row.cargo_id, row.cargo_nome, row.cargo_cor) {
            members[position].cargos.push(RoleSummary { id, nome, cor });
        }
    }
    Ok(Json(members))
}

async fn member_role(tx: &mut DbTransaction, guild: i64, member: i64) -> ApiResult<Option<String>> {
    sqlx::query_scalar(
        "SELECT papel FROM membros_servidor WHERE servidor_id = $1 AND usuario_id = $2",
    )
    .bind(guild)
    .bind(member)
    .fetch_optional(&mut **tx)
    .await
    .map_err(ApiError::internal)
}

async fn clear_member_roles(tx: &mut DbTransaction, guild: i64, member: i64) -> ApiResult<()> {
    sqlx::query("DELETE FROM membros_cargos WHERE servidor_id = $1 AND usuario_id = $2")
        .bind(guild)
        .bind(member)
        .execute(&mut **tx)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

async fn delete_membership(mut tx: DbTransaction, guild: i64, member: i64) -> ApiResult<()> {
    clear_member_roles(&mut tx, guild, member).await?;
    sqlx::query("DELETE FROM membros_servidor WHERE servidor_id = $1 AND usuario_id = $2")
        .bind(guild)
        .bind(member)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)
}

async fn leave_guild(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Extension(io): Extension<SocketIo>,
    Path(guild): Path<i64>,
) -> ApiResult<StatusCode> {
    let (mut tx, owner) = lock_guild(&state.db, guild).await?;
    let role = member_role(&mut tx, guild, user.id).await?.ok_or(ApiError(
        StatusCode::NOT_FOUND,
        "Você não é membro deste servidor.",
    ))?;
    if role == "dono" || owner == Some(user.id) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Quem criou o servidor não pode sair dele — só excluir.",
        ));
    }
    delete_membership(tx, guild, user.id).await?;
    crate::realtime::remove_server_access(&io, &state, guild, user.id).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn moderated_member(
    db: &PgPool,
    guild: i64,
    moderator: i64,
    member: i64,
    permission: &str,
    forbidden: ApiError,
    owner_protected: ApiError,
) -> ApiResult<DbTransaction> {
    let mut tx = managed_guild(db, guild, moderator, permission, forbidden).await?;
    let (role, owner): (String, i64) = sqlx::query_as(
        "SELECT m.papel, s.dono_id FROM membros_servidor m JOIN servidores s ON s.id = m.servidor_id
         WHERE m.servidor_id = $1 AND m.usuario_id = $2",
    )
    .bind(guild)
    .bind(member)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?
    .ok_or(ApiError(StatusCode::NOT_FOUND, "Membro não encontrado."))?;
    if role == "dono" || owner == member {
        return Err(owner_protected);
    }
    Ok(tx)
}

async fn kick_member(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Extension(io): Extension<SocketIo>,
    Path((guild, member)): Path<(i64, i64)>,
) -> ApiResult<StatusCode> {
    let tx = moderated_member(
        &state.db,
        guild,
        user.id,
        member,
        "gerenciar_membros",
        ApiError(StatusCode::FORBIDDEN, "Você não pode expulsar membros."),
        ApiError(StatusCode::FORBIDDEN, "O dono não pode ser expulso."),
    )
    .await?;
    delete_membership(tx, guild, member).await?;
    crate::realtime::remove_server_access(&io, &state, guild, member).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn ban_member(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Extension(io): Extension<SocketIo>,
    Path((guild, member)): Path<(i64, i64)>,
) -> ApiResult<StatusCode> {
    let mut tx = moderated_member(
        &state.db,
        guild,
        user.id,
        member,
        "banir_membros",
        ApiError(StatusCode::FORBIDDEN, "Você não pode banir membros."),
        ApiError(StatusCode::FORBIDDEN, "O dono não pode ser banido."),
    )
    .await?;
    sqlx::query(
        "INSERT INTO banimentos_servidor (servidor_id, usuario_id) VALUES ($1, $2)
         ON CONFLICT (servidor_id, usuario_id) DO NOTHING",
    )
    .bind(guild)
    .bind(member)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    delete_membership(tx, guild, member).await?;
    crate::realtime::remove_server_access(&io, &state, guild, member).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
struct Channel {
    id: i64,
    nome: String,
    tipo: String,
}

async fn list_channels(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Path(guild): Path<i64>,
) -> ApiResult<Json<Vec<Channel>>> {
    require_member(&state.db, guild, user.id).await?;
    sqlx::query_as("SELECT id, nome, tipo FROM canais WHERE servidor_id = $1 ORDER BY tipo, id")
        .bind(guild)
        .fetch_all(&state.db)
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

async fn create_channel(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Path(guild): Path<i64>,
    Json(input): Json<Value>,
) -> ApiResult<(StatusCode, Json<Channel>)> {
    let mut tx = managed_guild(
        &state.db,
        guild,
        user.id,
        "gerenciar_canais",
        MANAGE_CHANNELS_FORBIDDEN,
    )
    .await?;
    let name = input["nome"].as_str().unwrap_or_default().trim();
    if name.is_empty() || name.encode_utf16().count() > 32 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "O nome do canal precisa ter entre 1 e 32 caracteres.",
        ));
    }
    let kind = input["tipo"].as_str().unwrap_or_default();
    if !matches!(kind, "texto" | "voz") {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Tipo de canal inválido."));
    }
    let channel = sqlx::query_as(
        "INSERT INTO canais (servidor_id, nome, tipo) VALUES ($1, $2, $3) RETURNING id, nome, tipo",
    )
    .bind(guild)
    .bind(name)
    .bind(kind)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok((StatusCode::CREATED, Json(channel)))
}

async fn delete_channel(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Extension(io): Extension<SocketIo>,
    Path((guild, channel)): Path<(i64, i64)>,
) -> ApiResult<StatusCode> {
    let mut tx = managed_guild(
        &state.db,
        guild,
        user.id,
        "gerenciar_canais",
        MANAGE_CHANNELS_FORBIDDEN,
    )
    .await?;
    let deleted = sqlx::query("DELETE FROM canais WHERE id = $1 AND servidor_id = $2")
        .bind(channel)
        .bind(guild)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if deleted.rows_affected() == 0 {
        return Err(CHANNEL_NOT_FOUND);
    }
    tx.commit().await.map_err(ApiError::internal)?;
    crate::realtime::remove_channel_access(&io, &state, channel).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, sqlx::FromRow)]
struct ChannelMessage {
    id: i64,
    conteudo: String,
    #[serde(serialize_with = "serialize_timestamp")]
    criado_em: DateTime<Utc>,
    usuario_id: i64,
    anexo_nome: Option<String>,
    anexo_tipo: Option<String>,
    anexo_url: Option<String>,
    anexo_tamanho: Option<i64>,
    autor: String,
}

async fn channel_history(
    State(state): State<Arc<AppState>>,
    Authenticated(user): Authenticated,
    Path(channel): Path<i64>,
) -> ApiResult<Json<Vec<ChannelMessage>>> {
    let guild: i64 = sqlx::query_scalar("SELECT servidor_id FROM canais WHERE id = $1")
        .bind(channel)
        .fetch_optional(&state.db)
        .await
        .map_err(ApiError::internal)?
        .ok_or(CHANNEL_NOT_FOUND)?;
    require_member(&state.db, guild, user.id).await?;
    sqlx::query_as(
        "SELECT m.id, m.conteudo, m.criado_em, m.usuario_id, m.anexo_nome, m.anexo_tipo,
                m.anexo_url, m.anexo_tamanho, u.nome AS autor
         FROM mensagens m JOIN usuarios u ON u.id = m.usuario_id
         WHERE m.canal_id = $1 ORDER BY m.id LIMIT 100",
    )
    .bind(channel)
    .fetch_all(&state.db)
    .await
    .map(Json)
    .map_err(ApiError::internal)
}
