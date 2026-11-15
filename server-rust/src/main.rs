use std::{
    env,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State, rejection::JsonRejection},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{AUTHORIZATION, CACHE_CONTROL},
    },
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, SecondsFormat, Utc};
use jsonwebtoken::{DecodingKey, EncodingKey, Validation, decode};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::json;
use socketioxide::{
    SocketIo,
    extract::{Data, Extension, SocketRef, State as SocketState, TryData},
    handler::ConnectHandler,
};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
};

mod accounts;
mod direct_calls;
mod guilds;
mod ice;
mod realtime;
mod stream_rooms;

struct AppState {
    db: PgPool,
    signing_key: EncodingKey,
    verification_key: DecodingKey,
    live: Mutex<realtime::Live>,
    stream_rooms: Arc<stream_rooms::StreamRooms>,
    ice: Arc<ice::IceConfig>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Session {
    id: i64,
    nome: String,
    #[serde(default)]
    versao_sessao: i32,
    iat: i64,
    exp: i64,
}

#[derive(Deserialize)]
struct Credentials {
    email: String,
    senha: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct User {
    id: i64,
    nome: String,
    email: String,
    avatar_cor: String,
    avatar_url: Option<String>,
    banner_url: Option<String>,
    status: String,
    #[serde(skip)]
    senha_hash: String,
    #[serde(skip)]
    versao_sessao: i32,
}

#[derive(Deserialize)]
struct SocketAuth {
    token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessage {
    para_usuario_id: i64,
    conteudo: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct Message {
    id: i64,
    remetente_id: i64,
    conteudo: String,
    #[serde(serialize_with = "serialize_timestamp")]
    criado_em: DateTime<Utc>,
}

fn serialize_timestamp<S: Serializer>(
    time: &DateTime<Utc>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&time.to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NewMessage {
    com_usuario_id: i64,
    de_usuario_id: i64,
    mensagem: Message,
}

struct ApiError(StatusCode, &'static str);

impl ApiError {
    fn internal(error: impl std::fmt::Display) -> Self {
        eprintln!("Erro interno: {error}");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "Erro interno.")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "erro": self.1 }))).into_response()
    }
}

const WRONG_CREDENTIALS: ApiError =
    ApiError(StatusCode::UNAUTHORIZED, "Email ou senha incorretos.");
const NO_TOKEN: ApiError = ApiError(StatusCode::UNAUTHORIZED, "Token não fornecido.");
const INVALID_SESSION: ApiError = ApiError(StatusCode::UNAUTHORIZED, "Token inválido ou expirado.");
const CONVERSATION_FORBIDDEN: ApiError = ApiError(
    StatusCode::FORBIDDEN,
    "Adicione essa pessoa como amiga para conversar.",
);
const CAN_MESSAGE: &str = "
    $2::bigint BETWEEN 1 AND 9007199254740991 AND $1 <> $2 AND (
        EXISTS (SELECT 1 FROM amizades WHERE usuario_a_id = LEAST($1, $2)
            AND usuario_b_id = GREATEST($1, $2) AND estado = 'aceita')
        OR EXISTS (SELECT 1 FROM membros_servidor a
            JOIN membros_servidor b USING (servidor_id)
            WHERE a.usuario_id = $1 AND b.usuario_id = $2)
    )";

async fn login(
    State(state): State<Arc<AppState>>,
    input: Result<Json<Credentials>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let invalid = ApiError(StatusCode::BAD_REQUEST, "Preencha email e senha.");
    let Json(Credentials { email, senha }) = input.map_err(|error| match error {
        JsonRejection::JsonSyntaxError(_) => ApiError(StatusCode::BAD_REQUEST, "JSON inválido."),
        _ => invalid,
    })?;
    if accounts::js_trim(&email).is_empty() || senha.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "Preencha email e senha."));
    }
    let user = sqlx::query_as::<_, User>(&format!(
        "SELECT {} FROM usuarios WHERE email = $1",
        accounts::PROFILE_COLUMNS
    ))
    .bind(email)
    .fetch_optional(&state.db)
    .await
    .map_err(ApiError::internal)?
    .ok_or(WRONG_CREDENTIALS)?;

    let hash = user.senha_hash.clone();
    let valid = tokio::task::spawn_blocking(move || bcrypt::verify(senha, &hash))
        .await
        .map_err(ApiError::internal)?
        .unwrap_or(false);
    if !valid {
        return Err(WRONG_CREDENTIALS);
    }
    accounts::signed_user(&state, user)
}

async fn verify_session(state: &AppState, token: &str) -> Result<Session, ApiError> {
    let mut validation = Validation::default();
    validation.leeway = 0;
    let claims = decode::<Session>(token, &state.verification_key, &validation)
        .map_err(|_| INVALID_SESSION)?
        .claims;
    let version = sqlx::query_scalar::<_, i32>("SELECT versao_sessao FROM usuarios WHERE id = $1")
        .bind(claims.id)
        .fetch_optional(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if version != Some(claims.versao_sessao) {
        return Err(INVALID_SESSION);
    }
    Ok(claims)
}

async fn authenticate_http(state: &AppState, headers: &HeaderMap) -> Result<Session, ApiError> {
    let token = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(' ').nth(1))
        .filter(|value| !value.is_empty())
        .ok_or(NO_TOKEN)?;
    verify_session(state, token).await
}

async fn history(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(other): Path<String>,
) -> Result<
    (
        [(axum::http::HeaderName, HeaderValue); 1],
        Json<Vec<Message>>,
    ),
    ApiError,
> {
    let user = authenticate_http(&state, &headers).await?;
    let other = other.parse::<i64>().map_err(|_| CONVERSATION_FORBIDDEN)?;
    let allowed = sqlx::query_scalar::<_, bool>(&format!("SELECT {CAN_MESSAGE}"))
        .bind(user.id)
        .bind(other)
        .fetch_one(&state.db)
        .await
        .map_err(ApiError::internal)?;
    if !allowed {
        return Err(CONVERSATION_FORBIDDEN);
    }
    let messages = sqlx::query_as::<_, Message>(
        "SELECT id, remetente_id, conteudo, criado_em FROM mensagens_diretas
         WHERE (remetente_id = $1 AND destinatario_id = $2)
            OR (remetente_id = $2 AND destinatario_id = $1)
         ORDER BY id LIMIT 100",
    )
    .bind(user.id)
    .bind(other)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::internal)?;
    Ok((
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(messages),
    ))
}

async fn authenticate_socket(
    socket: SocketRef,
    SocketState(state): SocketState<Arc<AppState>>,
    TryData(data): TryData<SocketAuth>,
) -> Result<(), &'static str> {
    let token = data
        .ok()
        .and_then(|data| data.token)
        .filter(|value| !value.is_empty())
        .ok_or(NO_TOKEN.1)?;
    let claims = verify_session(&state, &token)
        .await
        .map_err(|_| "Token inválido.")?;
    if !realtime::session_current(&state, &claims) {
        return Err("Token inválido.");
    }
    socket.join(realtime::user_room(claims.id));
    realtime::register(&socket, &claims, &state);
    socket.extensions.insert(claims);
    socket.on("enviar-dm", send_message);
    Ok(())
}

async fn send_message(
    io: SocketIo,
    SocketState(state): SocketState<Arc<AppState>>,
    Extension(user): Extension<Session>,
    Data(input): Data<SendMessage>,
) {
    let text = input.conteudo.trim();
    if text.is_empty() {
        return;
    }
    let other = input.para_usuario_id;
    let result = sqlx::query_as::<_, Message>(&format!(
        "INSERT INTO mensagens_diretas (remetente_id, destinatario_id, conteudo)
         SELECT $1, $2, $3 WHERE {CAN_MESSAGE} RETURNING id, remetente_id, conteudo, criado_em",
    ))
    .bind(user.id)
    .bind(other)
    .bind(text)
    .fetch_optional(&state.db)
    .await;
    match result {
        Ok(Some(message)) => {
            let event = NewMessage {
                com_usuario_id: other,
                de_usuario_id: user.id,
                mensagem: message,
            };
            if let Err(error) = io
                .to([format!("user-{other}"), format!("user-{}", user.id)])
                .emit("nova-dm", &event)
                .await
            {
                eprintln!("Erro ao entregar mensagem: {error}");
            }
        }
        Ok(None) => {}
        Err(error) => eprintln!("Erro ao salvar mensagem: {error}"),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let test_url = env::var("ASTRALIS_TEST_DATABASE_URL").ok();
    let test_mode = test_url.is_some();
    let url = match test_url {
        Some(url) => url,
        None => env::var("DATABASE_URL")?,
    };
    let options: sqlx::postgres::PgConnectOptions = url.parse()?;
    if test_mode
        && (options.get_host() != "127.0.0.1"
            || options.get_database() != Some("astralis_rust_test"))
    {
        return Err("Use o PostgreSQL descartável astralis_rust_test em 127.0.0.1.".into());
    }
    let max_connections = env::var("PG_POOL_MAX")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(5);
    let db = PgPoolOptions::new()
        .max_connections(max_connections)
        .idle_timeout(Duration::from_secs(30))
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(options)
        .await?;
    let args: Vec<_> = env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "suporte-contas") {
        return accounts::run_support_cli(&db, &args[1..]).await;
    }
    if !args.is_empty() {
        return Err("Argumentos inválidos.".into());
    }
    let secret = env::var(if test_mode {
        "ASTRALIS_TEST_JWT_SECRET"
    } else {
        "JWT_SECRET"
    })?;
    if secret.is_empty() {
        return Err("A chave JWT está vazia.".into());
    }
    initialize_schema(&db).await?;
    let state = Arc::new(AppState {
        db,
        signing_key: EncodingKey::from_secret(secret.as_bytes()),
        verification_key: DecodingKey::from_secret(secret.as_bytes()),
        stream_rooms: Arc::new(stream_rooms::StreamRooms::default()),
        ice: Arc::new(ice::IceConfig::from_env()),
        live: Mutex::default(),
    });
    let (layer, io) = SocketIo::builder()
        .with_state(state.clone())
        .max_payload(8_000_000)
        .build_layer();
    io.ns("/", realtime::connected.with(authenticate_socket));
    let port = env::var(if test_mode {
        "ASTRALIS_RUST_PORT"
    } else {
        "PORT"
    })
    .unwrap_or_else(|_| {
        if test_mode {
            "3301".into()
        } else {
            "3001".into()
        }
    })
    .parse::<u16>()?;
    let mut app = Router::new()
        .route("/health", get(health))
        .route("/api/login", post(login))
        .route("/api/mensagens-diretas/{usuario_id}", get(history))
        .merge(accounts::routes())
        .merge(guilds::routes());
    app = if let Some(directory) = env::var_os("ASTRALIS_TEST_CLIENT_DIR").filter(|_| test_mode) {
        app.fallback_service(ServeDir::new(directory))
    } else {
        app.route(
            "/",
            get(async || "Servidor do app de comunicação está no ar!"),
        )
    };
    let app = app
        .with_state(state)
        .layer(axum::Extension(io))
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(layer)
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        );
    let listener =
        tokio::net::TcpListener::bind((if test_mode { "127.0.0.1" } else { "0.0.0.0" }, port))
            .await?;
    println!("Astralis Rust em http://{}", listener.local_addr()?);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn initialize_schema(db: &PgPool) -> Result<(), sqlx::Error> {
    let mut transaction = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(750021661103_i64)
        .execute(&mut *transaction)
        .await?;
    sqlx::raw_sql(include_str!("schema.sql"))
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await
}

async fn health(State(state): State<Arc<AppState>>) -> Response {
    let turn_configured = state.ice.turn_configured();
    let (status, body) = match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => (
            StatusCode::OK,
            json!({ "status": "ok", "turnConfigured": turn_configured,
            "features": { "friendships": true, "directCalls": true } }),
        ),
        Err(error) => {
            eprintln!("Erro na verificação do Postgres: {error}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({ "status": "unavailable", "turnConfigured": turn_configured }),
            )
        }
    };
    (
        status,
        [
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                axum::http::HeaderName::from_static("x-astralis-backend"),
                HeaderValue::from_static("rust"),
            ),
        ],
        Json(body),
    )
        .into_response()
}
