use std::{
    collections::HashMap,
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use jsonwebtoken::{Header, encode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use socketioxide::SocketIo;
use sqlx::PgPool;
use subtle::ConstantTimeEq;

use crate::{ApiError, AppState, Session, User, authenticate_http, realtime, serialize_timestamp};

const RECOVERY_INVALID: ApiError = ApiError(
    StatusCode::BAD_REQUEST,
    "Informe e-mail, código e uma nova senha de 8 a 128 caracteres.",
);
const RECOVERY_CODE_INVALID: ApiError = ApiError(
    StatusCode::BAD_REQUEST,
    "Código inválido ou expirado. Peça outro código ao suporte.",
);
pub(crate) const PROFILE_COLUMNS: &str = "id, nome, email, senha_hash, versao_sessao,
    NULLIF(avatar_url, '') AS avatar_url, NULLIF(banner_url, '') AS banner_url,
    COALESCE(NULLIF(avatar_cor, ''), '#5865f2') AS avatar_cor,
    COALESCE(NULLIF(status, ''), 'Disponível') AS status";
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone, Default)]
struct AccountAttempts {
    recovery: Arc<Mutex<HashMap<IpAddr, Attempt>>>,
    friend_requests: Arc<Mutex<HashMap<i64, Attempt>>>,
}

#[derive(Clone, Copy)]
struct Attempt {
    count: u32,
    expires: Instant,
}

pub(crate) fn routes() -> Router<Arc<AppState>> {
    let attempts = AccountAttempts::default();
    let friends = Router::new()
        .route("/api/amigos", get(list_friends))
        .route("/api/amigos/pedidos", get(list_requests).post(send_request))
        .route("/api/amigos/pedidos/{id}/aceitar", post(accept_request))
        .route("/api/amigos/pedidos/{id}", delete(delete_request))
        .route("/api/amigos/{id}", delete(remove_friend))
        .route_layer(middleware::from_fn(no_store));
    Router::new()
        .route("/api/cadastro", post(signup))
        .route("/api/perfil", get(profile).patch(update_profile))
        .route(
            "/api/redefinir-senha",
            post(reset_password).layer(middleware::from_fn(no_store)),
        )
        .merge(friends)
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(Extension(attempts))
}

async fn no_store(request: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub(crate) fn signed_user(state: &AppState, user: User) -> Result<Json<Value>, ApiError> {
    let now = Utc::now().timestamp();
    let claims = Session {
        id: user.id,
        nome: user.nome.clone(),
        versao_sessao: user.versao_sessao,
        iat: now,
        exp: now + 30 * 24 * 60 * 60,
    };
    let token =
        encode(&Header::default(), &claims, &state.signing_key).map_err(ApiError::internal)?;
    Ok(Json(json!({ "token": token, "usuario": user })))
}

async fn hash_password(password: String) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || bcrypt::hash(password, 10))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)
}

#[derive(Deserialize)]
struct Signup {
    nome: String,
    email: String,
    senha: String,
}

async fn signup(
    State(state): State<Arc<AppState>>,
    input: Result<Json<Signup>, JsonRejection>,
) -> Result<impl IntoResponse, ApiError> {
    const INVALID: ApiError = ApiError(StatusCode::BAD_REQUEST, "Preencha nome, email e senha.");
    const DUPLICATE: ApiError =
        ApiError(StatusCode::CONFLICT, "Já existe uma conta com este email.");
    let Json(Signup { nome, email, senha }) = input.map_err(|_| INVALID)?;
    if js_trim(&nome).is_empty() || js_trim(&email).is_empty() || senha.is_empty() {
        return Err(INVALID);
    }
    if senha.encode_utf16().count() < 6 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "A senha precisa ter pelo menos 6 caracteres.",
        ));
    }
    let exists =
        sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM usuarios WHERE email = $1)")
            .bind(&email)
            .fetch_one(&state.db)
            .await
            .map_err(ApiError::internal)?;
    if exists {
        return Err(DUPLICATE);
    }
    let password_hash = hash_password(senha).await?;
    let user = sqlx::query_as::<_, User>(&format!(
        "INSERT INTO usuarios (nome, email, senha_hash) VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING RETURNING {PROFILE_COLUMNS}"
    ))
    .bind(nome)
    .bind(email)
    .bind(password_hash)
    .fetch_optional(&state.db)
    .await
    .map_err(ApiError::internal)?
    .ok_or(DUPLICATE)?;
    Ok((StatusCode::CREATED, signed_user(&state, user)?))
}

async fn profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<User>, ApiError> {
    let session = authenticate_http(&state, &headers).await?;
    let user = sqlx::query_as::<_, User>(&format!(
        "SELECT {PROFILE_COLUMNS} FROM usuarios WHERE id = $1 AND versao_sessao = $2"
    ))
    .bind(session.id)
    .bind(session.versao_sessao)
    .fetch_optional(&state.db)
    .await
    .map_err(ApiError::internal)?
    .ok_or(crate::INVALID_SESSION)?;
    Ok(Json(user))
}

pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|ch: char| ch == '\u{feff}' || (ch.is_whitespace() && ch != '\u{85}'))
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.to_owned(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
        other => other.to_string(),
    }
}

fn profile_field(value: &Value) -> String {
    match value {
        Value::Bool(false) => String::new(),
        Value::Number(number) if number.as_f64() == Some(0.0) => String::new(),
        value => js_trim(&js_string(value)).to_owned(),
    }
}

async fn update_profile(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    input: Result<Json<Value>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let session = authenticate_http(&state, &headers).await?;
    const INVALID_NAME: ApiError = ApiError(
        StatusCode::BAD_REQUEST,
        "O nome precisa ter entre 1 e 32 caracteres.",
    );
    let Json(input) = input.map_err(|_| INVALID_NAME)?;
    let nome = profile_field(&input["nome"]);
    let status = profile_field(&input["status"]);
    let avatar_cor = profile_field(&input["avatar_cor"]);
    let avatar_url = profile_field(&input["avatar_url"]);
    let banner_url = profile_field(&input["banner_url"]);
    if nome.is_empty() || nome.encode_utf16().count() > 32 {
        return Err(INVALID_NAME);
    }
    if status.encode_utf16().count() > 80 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "O status pode ter no máximo 80 caracteres.",
        ));
    }
    if !avatar_cor
        .strip_prefix('#')
        .is_some_and(|value| value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Escolha uma cor de avatar válida.",
        ));
    }
    if !avatar_url.is_empty() && !avatar_url.starts_with("data:image/") {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Avatar deve ser uma imagem em base64 válida.",
        ));
    }
    if avatar_url.encode_utf16().count() > 1_000_000 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Avatar muito grande (máximo ~750KB).",
        ));
    }
    if !banner_url.is_empty()
        && (!banner_url.starts_with("data:image/") || banner_url.encode_utf16().count() > 2_000_000)
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Banner deve ser uma imagem válida de até ~1,5MB.",
        ));
    }

    let user = sqlx::query_as::<_, User>(&format!(
        "UPDATE usuarios SET nome = $1, status = COALESCE(NULLIF($2, ''), 'Disponível'),
            avatar_cor = $3, avatar_url = NULLIF($4, ''), banner_url = NULLIF($5, '')
         WHERE id = $6 AND versao_sessao = $7 RETURNING {PROFILE_COLUMNS}"
    ))
    .bind(nome)
    .bind(status)
    .bind(avatar_cor)
    .bind(avatar_url)
    .bind(banner_url)
    .bind(session.id)
    .bind(session.versao_sessao)
    .fetch_optional(&state.db)
    .await
    .map_err(ApiError::internal)?
    .ok_or(crate::INVALID_SESSION)?;
    signed_user(&state, user)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordReset {
    email: String,
    codigo: String,
    nova_senha: String,
}

fn recovery_code_hash(code: &str) -> String {
    format!("{:x}", Sha256::digest(code.as_bytes()))
}

async fn reset_password(
    State(state): State<Arc<AppState>>,
    Extension(io): Extension<SocketIo>,
    Extension(attempts): Extension<AccountAttempts>,
    peer: Result<ConnectInfo<SocketAddr>, axum::extract::rejection::ExtensionRejection>,
    headers: HeaderMap,
    input: Result<Json<PasswordReset>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let Json(input) = input.map_err(|_| RECOVERY_INVALID)?;
    let email = js_trim(&input.email);
    let code = js_trim(&input.codigo);
    if email.is_empty()
        || email.encode_utf16().count() > 254
        || code.is_empty()
        || code.encode_utf16().count() > 200
        || !(8..=128).contains(&input.nova_senha.encode_utf16().count())
    {
        return Err(RECOVERY_INVALID);
    }

    let peer = peer
        .map(|ConnectInfo(addr)| addr.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let ip = recovery_client_ip(peer, &headers);
    if !record_recovery_attempt(&attempts, ip) {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
        ));
    }

    let candidates = sqlx::query_scalar::<_, String>(
        "SELECT r.codigo_hash FROM recuperacoes_senha r JOIN usuarios u ON u.id = r.usuario_id
         WHERE BTRIM(u.email) = BTRIM($1) AND r.expira_em > NOW()",
    )
    .bind(email)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    let code_hash = recovery_code_hash(code);
    let mut valid = code_hash.as_bytes().ct_eq(&[0u8; 64]);
    for candidate in &candidates {
        valid |= code_hash.as_bytes().ct_eq(candidate.as_bytes());
    }
    if !bool::from(valid) {
        return Err(RECOVERY_CODE_INVALID);
    }

    let password = hash_password(input.nova_senha).await?;
    let (user_id, version) = sqlx::query_as::<_, (i64, i32)>(
        "WITH codigo_consumido AS (
            DELETE FROM recuperacoes_senha
            WHERE usuario_id IN (SELECT id FROM usuarios WHERE BTRIM(email) = BTRIM($1))
              AND codigo_hash = $2 AND expira_em > NOW()
            RETURNING usuario_id
         )
         UPDATE usuarios SET senha_hash = $3, versao_sessao = versao_sessao + 1
         WHERE id = (SELECT usuario_id FROM codigo_consumido)
         RETURNING id, versao_sessao",
    )
    .bind(email)
    .bind(code_hash)
    .bind(password)
    .fetch_optional(&state.db)
    .await
    .map_err(ApiError::internal)?
    .ok_or(RECOVERY_CODE_INVALID)?;
    realtime::revoke_sessions(&io, &state, user_id, version);
    Ok(Json(
        json!({ "mensagem": "Senha redefinida. Entre com a nova senha." }),
    ))
}

fn recovery_client_ip(peer: IpAddr, headers: &HeaderMap) -> IpAddr {
    // Match Express's one trusted proxy hop for the hosted backend.
    if std::env::var("NODE_ENV").as_deref() == Ok("production") {
        return headers
            .get_all("x-forwarded-for")
            .iter()
            .last()
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit(',').next())
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(peer);
    }
    peer
}

fn record_recovery_attempt(attempts: &AccountAttempts, ip: IpAddr) -> bool {
    let now = Instant::now();
    let mut attempts = attempts
        .recovery
        .lock()
        .expect("recovery rate limiter poisoned");
    if attempts.len() >= 1000 && !attempts.contains_key(&ip) {
        attempts.retain(|_, attempt| attempt.expires > now);
        if attempts.len() >= 1000 {
            if let Some(oldest) = attempts
                .iter()
                .min_by_key(|(_, attempt)| attempt.expires)
                .map(|(key, _)| *key)
            {
                attempts.remove(&oldest);
            }
        }
    }
    let attempt = attempts.entry(ip).or_insert(Attempt {
        count: 0,
        expires: now + Duration::from_secs(15 * 60),
    });
    if attempt.expires <= now {
        *attempt = Attempt {
            count: 0,
            expires: now + Duration::from_secs(15 * 60),
        };
    }
    if attempt.count >= 30 {
        return false;
    }
    attempt.count += 1;
    true
}

enum FriendshipError {
    Invalid(StatusCode, &'static str, &'static str),
    RateLimited(u64),
    Api(ApiError),
}

impl From<ApiError> for FriendshipError {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

impl From<sqlx::Error> for FriendshipError {
    fn from(error: sqlx::Error) -> Self {
        Self::Api(ApiError::internal(error))
    }
}

impl IntoResponse for FriendshipError {
    fn into_response(self) -> Response {
        match self {
            Self::Invalid(status, message, code) => {
                (status, Json(json!({ "erro": message, "codigo": code }))).into_response()
            }
            Self::RateLimited(seconds) => (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, seconds.to_string())],
                Json(json!({ "erro": "Muitos pedidos de amizade. Aguarde alguns minutos e tente novamente." })),
            ).into_response(),
            Self::Api(error) => error.into_response(),
        }
    }
}

const FRIEND_ID_INVALID: FriendshipError = FriendshipError::Invalid(
    StatusCode::BAD_REQUEST,
    "Identificador inválido.",
    "ID_INVALIDO",
);
const FRIEND_NAME_INVALID: FriendshipError = FriendshipError::Invalid(
    StatusCode::BAD_REQUEST,
    "Informe o nome ou identificador do seu amigo.",
    "NOME_INVALIDO",
);
const REQUEST_NOT_FOUND: FriendshipError = FriendshipError::Invalid(
    StatusCode::NOT_FOUND,
    "Pedido de amizade não encontrado.",
    "PEDIDO_NAO_ENCONTRADO",
);

fn valid_id(id: i64) -> bool {
    (1..=JS_MAX_SAFE_INTEGER).contains(&id)
}

fn parse_id(text: &str) -> Option<i64> {
    let text = js_trim(text);
    let prefix = text.get(..2).unwrap_or_default();
    let radix = match prefix {
        "0x" | "0X" => Some(16),
        "0b" | "0B" => Some(2),
        "0o" | "0O" => Some(8),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = text.get(2..)?;
        if digits.starts_with('+') {
            return None;
        }
        return i64::from_str_radix(digits, radix)
            .ok()
            .filter(|id| valid_id(*id));
    }
    let id = text.parse::<f64>().ok()?;
    (id.fract() == 0.0 && 1.0 <= id && id <= JS_MAX_SAFE_INTEGER as f64).then_some(id as i64)
}

fn ordered_pair(a: i64, b: i64) -> [i64; 2] {
    [a.min(b), a.max(b)]
}

pub(crate) async fn are_friends(db: &PgPool, a: i64, b: i64) -> Result<bool, sqlx::Error> {
    if a == b || !valid_id(a) || !valid_id(b) {
        return Ok(false);
    }
    let [a, b] = ordered_pair(a, b);
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM amizades WHERE usuario_a_id = $1 AND usuario_b_id = $2 AND estado = 'aceita')",
    )
    .bind(a)
    .bind(b)
    .fetch_one(db)
    .await
}

#[derive(Serialize, sqlx::FromRow)]
struct Friend {
    id: i64,
    nome: String,
    avatar_cor: String,
    avatar_url: Option<String>,
    status: String,
    #[sqlx(default)]
    online: bool,
}

impl Friend {
    fn with_presence(mut self, io: &SocketIo) -> Self {
        self.online = !io.to(format!("user-{}", self.id)).sockets().is_empty();
        self
    }
}

#[derive(Serialize)]
struct FriendRequest {
    id: i64,
    #[serde(serialize_with = "serialize_timestamp")]
    criado_em: DateTime<Utc>,
    usuario: Friend,
}

#[derive(sqlx::FromRow)]
struct PendingFriend {
    pedido_id: i64,
    remetente_id: i64,
    criado_em: DateTime<Utc>,
    #[sqlx(flatten)]
    user: Friend,
}

#[derive(Serialize, Default)]
struct FriendRequests {
    recebidos: Vec<FriendRequest>,
    enviados: Vec<FriendRequest>,
}

async fn list_friends(
    State(state): State<Arc<AppState>>,
    Extension(io): Extension<SocketIo>,
    headers: HeaderMap,
) -> Result<Json<Vec<Friend>>, FriendshipError> {
    let session = authenticate_http(&state, &headers).await?;
    let friends = sqlx::query_as::<_, Friend>(
        "SELECT u.id, u.nome, u.avatar_cor, u.avatar_url, u.status
         FROM amizades a JOIN usuarios u
            ON u.id = CASE WHEN a.usuario_a_id = $1 THEN a.usuario_b_id ELSE a.usuario_a_id END
         WHERE (a.usuario_a_id = $1 OR a.usuario_b_id = $1) AND a.estado = 'aceita'
         ORDER BY LOWER(u.nome), u.id",
    )
    .bind(session.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        friends
            .into_iter()
            .map(|friend| friend.with_presence(&io))
            .collect(),
    ))
}

async fn list_requests(
    State(state): State<Arc<AppState>>,
    Extension(io): Extension<SocketIo>,
    headers: HeaderMap,
) -> Result<Json<FriendRequests>, FriendshipError> {
    let session = authenticate_http(&state, &headers).await?;
    let pending = sqlx::query_as::<_, PendingFriend>(
        "SELECT a.id AS pedido_id, a.remetente_id, a.criado_em, u.id, u.nome, u.avatar_cor, u.avatar_url, u.status
         FROM amizades a JOIN usuarios u
            ON u.id = CASE WHEN a.usuario_a_id = $1 THEN a.usuario_b_id ELSE a.usuario_a_id END
         WHERE (a.usuario_a_id = $1 OR a.usuario_b_id = $1) AND a.estado = 'pendente'
         ORDER BY a.id DESC",
    )
    .bind(session.id)
    .fetch_all(&state.db)
    .await?;
    let mut requests = FriendRequests::default();
    for row in pending {
        let target = if row.remetente_id == session.id {
            &mut requests.enviados
        } else {
            &mut requests.recebidos
        };
        target.push(FriendRequest {
            id: row.pedido_id,
            criado_em: row.criado_em,
            usuario: row.user.with_presence(&io),
        });
    }
    Ok(Json(requests))
}

async fn find_user(db: &PgPool, name: &str) -> Result<Friend, FriendshipError> {
    let name = js_trim(name);
    if name.is_empty() || name.encode_utf16().count() > 128 {
        return Err(FRIEND_NAME_INVALID);
    }
    if let Some((prefix, suffix)) = name.rsplit_once('#').filter(|(prefix, suffix)| {
        !prefix.contains(['\r', '\n', '\u{2028}', '\u{2029}'])
            && matches!(suffix.as_bytes().first(), Some(b'1'..=b'9'))
            && suffix.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        const NOT_FOUND: FriendshipError = FriendshipError::Invalid(
            StatusCode::NOT_FOUND,
            "Pessoa não encontrada. Confira o identificador.",
            "USUARIO_NAO_ENCONTRADO",
        );
        let id = suffix
            .parse::<i64>()
            .ok()
            .filter(|id| valid_id(*id))
            .ok_or(NOT_FOUND)?;
        return sqlx::query_as::<_, Friend>(
            "SELECT id, nome, avatar_cor, avatar_url, status FROM usuarios WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(db)
        .await?
        .filter(|user| {
            prefix.is_empty()
                || js_trim(prefix).to_lowercase() == js_trim(&user.nome).to_lowercase()
        })
        .ok_or(NOT_FOUND);
    }

    let matches = sqlx::query_as::<_, Friend>(
        "SELECT id, nome, avatar_cor, avatar_url, status FROM usuarios
         WHERE LOWER(TRIM(nome)) = LOWER($1) ORDER BY id LIMIT 2",
    )
    .bind(name)
    .fetch_all(db)
    .await?;
    if matches.len() > 1 {
        return Err(FriendshipError::Invalid(
            StatusCode::CONFLICT,
            "Há mais de uma pessoa com esse nome. Peça o identificador no formato Nome#ID.",
            "NOME_AMBIGUO",
        ));
    }
    matches.into_iter().next().ok_or(FriendshipError::Invalid(
        StatusCode::NOT_FOUND,
        "Pessoa não encontrada. Confira o nome ou use Nome#ID.",
        "USUARIO_NAO_ENCONTRADO",
    ))
}

fn record_friend_attempt(attempts: &AccountAttempts, user: i64) -> Result<(), FriendshipError> {
    let now = Instant::now();
    let mut attempts = attempts
        .friend_requests
        .lock()
        .expect("friend request rate limiter poisoned");
    attempts.retain(|_, attempt| attempt.expires > now);
    if attempts.len() >= 10_000 && !attempts.contains_key(&user) {
        return Err(FriendshipError::RateLimited(10 * 60));
    }
    let attempt = attempts.entry(user).or_insert(Attempt {
        count: 0,
        expires: now + Duration::from_secs(10 * 60),
    });
    if attempt.count >= 30 {
        let remaining = attempt
            .expires
            .duration_since(now)
            .as_millis()
            .div_ceil(1000)
            .max(1);
        return Err(FriendshipError::RateLimited(remaining as u64));
    }
    attempt.count += 1;
    Ok(())
}

async fn send_request(
    State(state): State<Arc<AppState>>,
    Extension(io): Extension<SocketIo>,
    Extension(attempts): Extension<AccountAttempts>,
    headers: HeaderMap,
    input: Result<Json<Value>, JsonRejection>,
) -> Result<impl IntoResponse, FriendshipError> {
    let session = authenticate_http(&state, &headers).await?;
    record_friend_attempt(&attempts, session.id)?;
    let Json(input) = input.map_err(|_| FRIEND_NAME_INVALID)?;
    let user = find_user(
        &state.db,
        input["nome"].as_str().ok_or(FRIEND_NAME_INVALID)?,
    )
    .await?;
    if user.id == session.id {
        return Err(FriendshipError::Invalid(
            StatusCode::BAD_REQUEST,
            "Você não pode adicionar a si mesmo.",
            "AUTO_AMIZADE",
        ));
    }

    let pair = ordered_pair(session.id, user.id);
    let inserted = sqlx::query_as::<_, (i64, DateTime<Utc>)>(
        "INSERT INTO amizades (usuario_a_id, usuario_b_id, remetente_id) VALUES ($1, $2, $3)
         ON CONFLICT (usuario_a_id, usuario_b_id) DO NOTHING RETURNING id, criado_em",
    )
    .bind(pair[0])
    .bind(pair[1])
    .bind(session.id)
    .fetch_optional(&state.db)
    .await?;
    let Some((id, criado_em)) = inserted else {
        let existing = sqlx::query_as::<_, (String, i64)>(
            "SELECT estado, remetente_id FROM amizades WHERE usuario_a_id = $1 AND usuario_b_id = $2",
        )
        .bind(pair[0]).bind(pair[1])
        .fetch_optional(&state.db).await?;
        return Err(match existing {
            Some((status, _)) if status == "aceita" => FriendshipError::Invalid(
                StatusCode::CONFLICT,
                "Essa pessoa já está na sua lista de amigos.",
                "AMIZADE_EXISTENTE",
            ),
            Some((_, requester)) if requester == session.id => FriendshipError::Invalid(
                StatusCode::CONFLICT,
                "Você já enviou um pedido para essa pessoa.",
                "PEDIDO_ENVIADO",
            ),
            _ => FriendshipError::Invalid(
                StatusCode::CONFLICT,
                "Essa pessoa já enviou um pedido para você. Aceite-o na aba Pendentes.",
                "PEDIDO_RECEBIDO",
            ),
        });
    };
    realtime::notify_friendships(&io, &state, &pair, "pedido-enviado").await;
    let request = FriendRequest {
        id,
        criado_em,
        usuario: user.with_presence(&io),
    };
    Ok((
        StatusCode::CREATED,
        Json(json!({"mensagem": "Pedido de amizade enviado.", "pedido": request})),
    ))
}

async fn accept_request(
    State(state): State<Arc<AppState>>,
    Extension(io): Extension<SocketIo>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, FriendshipError> {
    let session = authenticate_http(&state, &headers).await?;
    let id = parse_id(&id).ok_or(FRIEND_ID_INVALID)?;
    let (a, b) = sqlx::query_as::<_, (i64, i64)>(
        "UPDATE amizades SET estado = 'aceita', aceito_em = CURRENT_TIMESTAMP
         WHERE id = $1 AND estado = 'pendente' AND remetente_id != $2
           AND (usuario_a_id = $2 OR usuario_b_id = $2)
         RETURNING usuario_a_id, usuario_b_id",
    )
    .bind(id)
    .bind(session.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(REQUEST_NOT_FOUND)?;
    realtime::notify_friendships(&io, &state, &[a, b], "pedido-aceito").await;
    Ok(Json(json!({"mensagem": "Pedido de amizade aceito."})))
}

async fn delete_request(
    State(state): State<Arc<AppState>>,
    Extension(io): Extension<SocketIo>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, FriendshipError> {
    let session = authenticate_http(&state, &headers).await?;
    let id = parse_id(&id).ok_or(FRIEND_ID_INVALID)?;
    let (a, b) = sqlx::query_as::<_, (i64, i64)>(
        "DELETE FROM amizades WHERE id = $1 AND estado = 'pendente'
           AND (usuario_a_id = $2 OR usuario_b_id = $2)
         RETURNING usuario_a_id, usuario_b_id",
    )
    .bind(id)
    .bind(session.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(REQUEST_NOT_FOUND)?;
    realtime::notify_friendships(&io, &state, &[a, b], "pedido-removido").await;
    Ok(Json(json!({"mensagem": "Pedido de amizade removido."})))
}

async fn remove_friend(
    State(state): State<Arc<AppState>>,
    Extension(io): Extension<SocketIo>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, FriendshipError> {
    let session = authenticate_http(&state, &headers).await?;
    let id = parse_id(&id).ok_or(FRIEND_ID_INVALID)?;
    let pair = ordered_pair(session.id, id);
    let removed = sqlx::query(
        "DELETE FROM amizades WHERE usuario_a_id = $1 AND usuario_b_id = $2 AND estado = 'aceita'",
    )
    .bind(pair[0])
    .bind(pair[1])
    .execute(&state.db)
    .await?;
    if removed.rows_affected() == 0 {
        return Err(FriendshipError::Invalid(
            StatusCode::NOT_FOUND,
            "Amizade não encontrada.",
            "AMIZADE_NAO_ENCONTRADA",
        ));
    }
    realtime::notify_friendships(&io, &state, &pair, "amizade-removida").await;
    Ok(Json(
        json!({"mensagem": "Pessoa removida da lista de amigos."}),
    ))
}

pub(crate) async fn run_support_cli(
    db: &PgPool,
    args: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    match args.first().map(String::as_str) {
        Some("buscar") => {
            let term = args.get(1).map_or("", |arg| js_trim(arg));
            if !(3..=80).contains(&term.encode_utf16().count()) {
                return Err("Informe pelo menos 3 caracteres do nome ou e-mail.".into());
            }
            let users = sqlx::query_as::<_, (i64, String, String, DateTime<Utc>)>(
                "SELECT id, nome, email, criado_em FROM usuarios
                 WHERE nome ILIKE $1 OR email ILIKE $1 ORDER BY criado_em DESC LIMIT 20",
            )
            .bind(format!("%{term}%"))
            .fetch_all(db)
            .await?;
            for (id, name, email, created) in users {
                println!("{id}\t{name:?}\t{email:?}\t{}", created.to_rfc3339());
            }
        }
        Some("gerar") => {
            let id = args
                .get(1)
                .and_then(|arg| parse_id(arg))
                .ok_or("Informe o ID numérico da conta.")?;
            let (name, email) = sqlx::query_as::<_, (String, String)>(
                "SELECT nome, email FROM usuarios WHERE id = $1",
            )
            .bind(id)
            .fetch_optional(db)
            .await?
            .ok_or("Conta não encontrada.")?;
            let confirmation = format!("GERAR {id}");
            print!(
                "Conta: {name:?} ({email:?}). Confirme a identidade por outro contato. Digite {confirmation} para criar o código: "
            );
            io::stdout().flush()?;
            let mut answer = String::new();
            io::stdin().read_line(&mut answer)?;
            if js_trim(&answer) != confirmation {
                println!("Operação cancelada.");
                return Ok(());
            }

            let mut entropy = [0u8; 24];
            getrandom::fill(&mut entropy).map_err(|error| error.to_string())?;
            let code = URL_SAFE_NO_PAD.encode(entropy);
            sqlx::query(
                "INSERT INTO recuperacoes_senha (usuario_id, codigo_hash, expira_em)
                 VALUES ($1, $2, NOW() + INTERVAL '20 minutes')
                 ON CONFLICT (usuario_id) DO UPDATE
                 SET codigo_hash = EXCLUDED.codigo_hash, expira_em = EXCLUDED.expira_em",
            )
            .bind(id)
            .bind(recovery_code_hash(&code))
            .execute(db)
            .await?;
            println!("E-mail da conta: {email}");
            println!("Código de recuperação (uso único, 20 minutos): {code}");
            println!(
                "Envie o e-mail e o código somente à pessoa identificada, por um canal privado."
            );
        }
        _ => {
            println!("Uso: astralis-server suporte-contas buscar <nome-ou-email>");
            println!("     astralis-server suporte-contas gerar <id-da-conta>");
        }
    }
    Ok(())
}
