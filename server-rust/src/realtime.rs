use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, MutexGuard},
};

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Map, Value, json};
use socketioxide::{
    SocketIo,
    extract::{AckSender, Extension, SocketRef, State, TryData},
    socket::Sid,
};

use crate::{
    AppState, Session,
    direct_calls::{self, Calls, DIRECT_PREFIX, Profile},
    guilds, stream_rooms,
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Participant {
    pub(crate) socket_id: String,
    pub(crate) usuario_id: i64,
    pub(crate) nome: String,
    pub(crate) avatar_cor: String,
    pub(crate) avatar_url: Option<String>,
}

#[derive(Default)]
pub(crate) struct Live {
    pub(crate) calls: Calls,
    user_sockets: HashMap<i64, HashSet<Sid>>,
    voice_by_socket: HashMap<Sid, i64>,
    voice_by_channel: HashMap<i64, HashMap<Sid, Participant>>,
    min_session_versions: HashMap<i64, i32>,
}

pub(crate) fn lock(state: &AppState) -> MutexGuard<'_, Live> {
    state.live.lock().expect("estado de conexão envenenado")
}

pub(crate) fn user_room(id: i64) -> String {
    format!("user-{id}")
}

pub(crate) fn wire_id(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|id| (1..=9_007_199_254_740_991).contains(id))
}

pub(crate) fn emit<T: Serialize>(io: &SocketIo, sid: Sid, event: &str, value: &T) {
    if let Some(socket) = io.get_socket(sid) {
        let _ = socket.emit(event, value);
    }
}

pub(crate) fn externally_busy(state: &AppState, io: &SocketIo, live: &Live, user: i64) -> bool {
    io.within(user_room(user)).sockets().iter().any(|socket| {
        socket.connected()
            && (live.voice_by_socket.contains_key(&socket.id)
                || state.stream_rooms.contains_socket(&socket.id.to_string()))
    })
}

pub(crate) fn session_current(state: &AppState, user: &Session) -> bool {
    !lock(state)
        .min_session_versions
        .get(&user.id)
        .is_some_and(|version| user.versao_sessao < *version)
}

pub(crate) fn revoke_sessions(io: &SocketIo, state: &AppState, user_id: i64, version: i32) {
    {
        let mut live = lock(state);
        let floor = live.min_session_versions.entry(user_id).or_insert(version);
        *floor = (*floor).max(version);
    }
    for socket in io.within(user_room(user_id)).sockets() {
        if socket
            .extensions
            .get::<Session>()
            .is_some_and(|session| session.versao_sessao < version)
        {
            let _ = socket.disconnect();
        }
    }
}

pub(crate) async fn notify_friendships(
    io: &SocketIo,
    state: &AppState,
    user_ids: &[i64],
    kind: &str,
) {
    for id in user_ids {
        let _ = io
            .to(user_room(*id))
            .emit("amizades-atualizadas", &json!({ "tipo": kind }))
            .await;
    }
    let pairs = lock(state).calls.relevant_pairs(user_ids);
    for (call_id, a, b) in pairs {
        match crate::accounts::are_friends(&state.db, a, b).await {
            Ok(false) => lock(state).calls.friendship_removed(io, &call_id),
            Err(error) => eprintln!("Erro ao atualizar chamadas após mudança de amizade: {error}"),
            _ => {}
        }
    }
}

async fn announce_presence(
    io: &SocketIo,
    state: &AppState,
    user: i64,
    online: bool,
) -> Result<(), sqlx::Error> {
    let friends_and_members: Vec<i64> = sqlx::query_scalar(
        "SELECT CASE WHEN usuario_a_id = $1 THEN usuario_b_id ELSE usuario_a_id END
         FROM amizades WHERE $1 IN (usuario_a_id, usuario_b_id) AND estado = 'aceita'
         UNION
         SELECT b.usuario_id FROM membros_servidor a JOIN membros_servidor b USING (servidor_id)
         WHERE a.usuario_id = $1 AND b.usuario_id <> $1",
    )
    .bind(user)
    .fetch_all(&state.db)
    .await?;
    if lock(state).user_sockets.contains_key(&user) == online {
        let event = if online {
            "amigo-online"
        } else {
            "amigo-offline"
        };
        let rooms: Vec<_> = friends_and_members.into_iter().map(user_room).collect();
        if !rooms.is_empty() {
            let _ = io
                .to(rooms)
                .emit(event, &json!({ "usuarioId": user }))
                .await;
        }
    }
    Ok(())
}

pub(crate) async fn connected(
    socket: SocketRef,
    io: SocketIo,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<Session>,
) {
    let first = {
        let mut live = lock(&state);
        if !socket.connected() {
            return;
        }
        if live
            .min_session_versions
            .get(&user.id)
            .is_some_and(|version| user.versao_sessao < *version)
        {
            let _ = socket.disconnect();
            return;
        }
        let sockets = live.user_sockets.entry(user.id).or_default();
        let first = sockets.is_empty();
        sockets.insert(socket.id);
        live.calls.reconnect(&socket, user.id);
        first
    };
    if first {
        log_error(announce_presence(&io, &state, user.id, true).await);
    }
}

async fn disconnected(
    socket: SocketRef,
    io: SocketIo,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<Session>,
) {
    stream_rooms::disconnected(&socket, &io, Arc::clone(&state.stream_rooms));
    let (changed_channel, last) = {
        let mut live = lock(&state);
        live.calls.disconnect(&io, socket.id, user.id);
        let changed = leave_guild_voice(&mut live, &io, &socket);
        let last = live
            .user_sockets
            .get_mut(&user.id)
            .is_some_and(|sockets| sockets.remove(&socket.id) && sockets.is_empty());
        if last {
            live.user_sockets.remove(&user.id);
        }
        (changed, last)
    };
    if let Some(channel) = changed_channel {
        log_error(announce_voice(&io, &state, channel).await);
    }
    if last {
        log_error(announce_presence(&io, &state, user.id, false).await);
    }
}

fn log_error(result: Result<(), sqlx::Error>) {
    if let Err(error) = result {
        eprintln!("Erro em evento Socket.IO: {error}");
    }
}

async fn channel_server(state: &AppState, id: i64) -> Result<Option<i64>, sqlx::Error> {
    sqlx::query_scalar("SELECT servidor_id FROM canais WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await
}

async fn authorized_channel(
    state: &AppState,
    user: i64,
    channel: i64,
) -> Result<bool, sqlx::Error> {
    match channel_server(state, channel).await? {
        Some(server) => guilds::is_member(&state.db, server, user).await,
        None => Ok(false),
    }
}

async fn join_text(
    socket: SocketRef,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<Session>,
    TryData(input): TryData<Value>,
) {
    let Some(id) = input.ok().as_ref().and_then(wire_id) else {
        return;
    };
    match authorized_channel(&state, user.id, id).await {
        Ok(true) if socket.connected() => socket.join(format!("canal-{id}")),
        Err(error) => eprintln!("Erro ao entrar no canal de texto: {error}"),
        _ => {}
    }
}

async fn leave_text(socket: SocketRef, TryData(input): TryData<Value>) {
    if let Some(id) = input.ok().as_ref().and_then(wire_id) {
        socket.leave(format!("canal-{id}"));
    }
}

async fn send_text(
    io: &SocketIo,
    state: &AppState,
    user: &Session,
    data: Value,
) -> Result<(), sqlx::Error> {
    let Some(channel) = data.get("canalId").and_then(wire_id) else {
        return Ok(());
    };
    let text = data
        .get("conteudo")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let attachment = data.get("anexo");
    let field = |name: &str| {
        attachment
            .and_then(|entry| entry.get(name))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let url = field("url");
    if (text.is_empty() && url.is_none())
        || url.is_some_and(|value| {
            !value.starts_with("data:") || value.encode_utf16().count() > 7_000_000
        })
        || !authorized_channel(state, user.id, channel).await?
    {
        return Ok(());
    }
    let (name, mime) = (field("nome"), field("tipo"));
    let size = attachment
        .and_then(|entry| entry.get("tamanho"))
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
        .filter(|size| *size != 0);
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO mensagens (canal_id, usuario_id, conteudo, anexo_nome, anexo_tipo, anexo_url, anexo_tamanho)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    ).bind(channel).bind(user.id).bind(text).bind(name).bind(mime).bind(url).bind(size)
        .fetch_one(&state.db).await?;
    let result = json!({
        "canalId": channel, "mensagem": {
            "id": id, "conteudo": text, "autor": user.nome, "usuario_id": user.id,
            "anexo_nome": name, "anexo_tipo": mime, "anexo_url": url, "anexo_tamanho": size,
            "criado_em": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
        }
    });
    let _ = io
        .to(format!("canal-{channel}"))
        .emit("nova-mensagem", &result)
        .await;
    Ok(())
}

async fn delete_text(
    io: &SocketIo,
    state: &AppState,
    user: &Session,
    data: Value,
) -> Result<(), sqlx::Error> {
    let (Some(channel), Some(id)) = (
        data.get("canalId").and_then(wire_id),
        data.get("mensagemId").and_then(wire_id),
    ) else {
        return Ok(());
    };
    let Some(server) = channel_server(state, channel).await? else {
        return Ok(());
    };
    if !guilds::is_member(&state.db, server, user.id).await? {
        return Ok(());
    }
    let Some(owner) = sqlx::query_scalar::<_, i64>(
        "SELECT usuario_id FROM mensagens WHERE id = $1 AND canal_id = $2",
    )
    .bind(id)
    .bind(channel)
    .fetch_optional(&state.db)
    .await?
    else {
        return Ok(());
    };
    if owner != user.id
        && !guilds::has_permission(&state.db, server, user.id, "gerenciar_mensagens").await?
    {
        return Ok(());
    }
    let result = sqlx::query("DELETE FROM mensagens WHERE id = $1 AND canal_id = $2")
        .bind(id)
        .bind(channel)
        .execute(&state.db)
        .await?;
    if result.rows_affected() > 0 {
        let _ = io
            .to(format!("canal-{channel}"))
            .emit(
                "mensagem-apagada",
                &json!({ "canalId": channel, "mensagemId": id }),
            )
            .await;
    }
    Ok(())
}

fn participants(live: &Live, channel: i64) -> Vec<Participant> {
    live.voice_by_channel
        .get(&channel)
        .map(|peers| peers.values().cloned().collect())
        .unwrap_or_default()
}

async fn announce_voice(io: &SocketIo, state: &AppState, channel: i64) -> Result<(), sqlx::Error> {
    let Some(server) = channel_server(state, channel).await? else {
        return Ok(());
    };
    let members: Vec<i64> =
        sqlx::query_scalar("SELECT usuario_id FROM membros_servidor WHERE servidor_id = $1")
            .bind(server)
            .fetch_all(&state.db)
            .await?;
    let peers = participants(&lock(state), channel);
    let rooms: Vec<_> = members.into_iter().map(user_room).collect();
    if !rooms.is_empty() {
        let _ = io
            .to(rooms)
            .emit(
                "presenca-voz-canal",
                &json!({ "canalId": channel, "participantes": peers }),
            )
            .await;
    }
    Ok(())
}

fn leave_guild_voice(live: &mut Live, io: &SocketIo, socket: &SocketRef) -> Option<i64> {
    let channel = live.voice_by_socket.remove(&socket.id)?;
    if let Some(peers) = live.voice_by_channel.get_mut(&channel) {
        peers.remove(&socket.id);
        let event = json!({ "socketId": socket.id.to_string() });
        for peer in peers.keys() {
            emit(io, *peer, "peer-saiu", &event);
        }
        if peers.is_empty() {
            live.voice_by_channel.remove(&channel);
        }
    }
    Some(channel)
}

async fn join_voice(
    socket: SocketRef,
    io: SocketIo,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<Session>,
    TryData(input): TryData<Value>,
    ack: AckSender,
) {
    let Ok(channel) = input else {
        return;
    };
    if let Some(direct) = channel
        .as_str()
        .filter(|value| value.starts_with(DIRECT_PREFIX))
    {
        let result = {
            let mut live = lock(&state);
            if live.voice_by_socket.contains_key(&socket.id) {
                json!({ "ok": false, "code": "busy", "error": "Encerre sua chamada atual." })
            } else {
                live.calls.join_voice(&io, &socket, direct)
            }
        };
        if result["ok"] != true {
            let _ = socket.emit("voz:erro", &result);
        }
        let _ = ack.send(&result);
        return;
    }
    let Some(id) = wire_id(&channel) else {
        return;
    };
    let result = async {
        if !authorized_channel(&state, user.id, id).await? {
            return Ok(None);
        }
        Profile::load(&state.db, user.id).await
    }
    .await;
    let profile = match result {
        Ok(Some(profile)) => profile,
        Ok(None) => return,
        Err(error) => {
            eprintln!("Erro ao entrar no canal de voz: {error}");
            return;
        }
    };
    let left = {
        let mut live = lock(&state);
        if !socket.connected() {
            return;
        }
        let own_channel = live.voice_by_socket.get(&socket.id).copied();
        let busy = live.calls.is_busy(user.id)
            || (own_channel.is_none() && externally_busy(&state, &io, &live, user.id));
        if busy {
            let value = json!({ "ok": false, "code": "busy", "error": "Encerre sua chamada atual antes de entrar neste canal." });
            let _ = socket.emit("voz:erro", &value);
            let _ = ack.send(&value);
            return;
        }
        if own_channel == Some(id) {
            let peers: Vec<_> = participants(&live, id)
                .into_iter()
                .filter(|peer| peer.socket_id != socket.id.to_string())
                .collect();
            let _ = socket.emit("peers-existentes", &json!({ "peers": peers }));
            let _ = ack.send(&json!({ "ok": true }));
            return;
        }
        let old_channel = leave_guild_voice(&mut live, &io, &socket);
        let peer = profile.participant(socket.id, "#5865f2");
        let others = live.voice_by_channel.entry(id).or_default();
        let _ = socket.emit(
            "peers-existentes",
            &json!({ "peers": others.values().collect::<Vec<_>>() }),
        );
        for sid in others.keys() {
            emit(&io, *sid, "novo-peer", &peer);
        }
        others.insert(socket.id, peer);
        live.voice_by_socket.insert(socket.id, id);
        old_channel
    };
    let _ = ack.send(&json!({ "ok": true }));
    if let Some(previous) = left {
        log_error(announce_voice(&io, &state, previous).await);
    }
    log_error(announce_voice(&io, &state, id).await);
}

async fn leave_voice(
    socket: SocketRef,
    io: SocketIo,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<Session>,
) {
    let channel = {
        let mut live = lock(&state);
        if live.calls.leave_voice(&io, socket.id, user.id) {
            return;
        }
        leave_guild_voice(&mut live, &io, &socket)
    };
    if let Some(channel) = channel {
        log_error(announce_voice(&io, &state, channel).await);
    }
}

async fn voice_snapshot(
    socket: SocketRef,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<Session>,
    TryData(input): TryData<Value>,
) {
    let Some(server) = input.ok().as_ref().and_then(wire_id) else {
        return;
    };
    let load = async {
        if !guilds::is_member(&state.db, server, user.id).await? {
            return Ok(());
        }
        let channels: Vec<i64> =
            sqlx::query_scalar("SELECT id FROM canais WHERE servidor_id = $1 AND tipo = 'voz'")
                .bind(server)
                .fetch_all(&state.db)
                .await?;
        let live = lock(&state);
        let snapshot: HashMap<_, _> = channels
            .into_iter()
            .map(|id| (id.to_string(), participants(&live, id)))
            .collect();
        let _ = socket.emit(
            "presenca-voz-servidor",
            &json!({ "participantesPorCanal": snapshot }),
        );
        Ok(())
    };
    log_error(load.await);
}

async fn kick_voice(
    io: SocketIo,
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<Session>,
    TryData(input): TryData<Value>,
) {
    let Ok(data) = input else {
        return;
    };
    let (Some(channel), Some(target)) = (
        data.get("canalId").and_then(wire_id),
        data.get("usuarioId").and_then(wire_id),
    ) else {
        return;
    };
    let change = async {
        let Some(server) = channel_server(&state, channel).await? else {
            return Ok(());
        };
        if !guilds::has_permission(&state.db, server, user.id, "expulsar_call").await? {
            return Ok(());
        }
        {
            let mut live = lock(&state);
            for socket in io.within(user_room(target)).sockets() {
                if live.voice_by_socket.get(&socket.id) == Some(&channel) {
                    let _ = socket.emit("voce-foi-expulso-da-call", &());
                    leave_guild_voice(&mut live, &io, &socket);
                }
            }
        }
        announce_voice(&io, &state, channel).await
    };
    log_error(change.await);
}

pub(crate) async fn remove_server_access(io: &SocketIo, state: &AppState, server: i64, user: i64) {
    let result = async {
        if guilds::is_member(&state.db, server, user).await? {
            return Ok(());
        }
        let channels: Vec<i64> = sqlx::query_scalar("SELECT id FROM canais WHERE servidor_id = $1")
            .bind(server)
            .fetch_all(&state.db)
            .await?;
        let mut changed = HashSet::new();
        {
            let mut live = lock(state);
            for socket in io.within(user_room(user)).sockets() {
                for channel in &channels {
                    socket.leave(format!("canal-{channel}"));
                }
                if let Some(channel) = live
                    .voice_by_socket
                    .get(&socket.id)
                    .copied()
                    .filter(|id| channels.contains(id))
                {
                    let _ = socket.emit("voce-foi-expulso-da-call", &());
                    leave_guild_voice(&mut live, io, &socket);
                    changed.insert(channel);
                }
            }
        }
        for channel in changed {
            announce_voice(io, state, channel).await?;
        }
        Ok(())
    };
    log_error(result.await);
}

pub(crate) async fn remove_channel_access(io: &SocketIo, state: &AppState, channel: i64) {
    let text_room = format!("canal-{channel}");
    for socket in io.within(text_room.clone()).sockets() {
        socket.leave(text_room.clone());
    }
    let mut live = lock(state);
    if let Some(peers) = live.voice_by_channel.remove(&channel) {
        for sid in peers.keys() {
            live.voice_by_socket.remove(sid);
            emit(io, *sid, "voce-foi-expulso-da-call", &());
        }
    }
}

fn voice_peers(state: &AppState, sid: Sid, user: i64) -> Vec<Sid> {
    let live = lock(state);
    if let Some(channel) = live
        .voice_by_socket
        .get(&sid)
        .and_then(|id| live.voice_by_channel.get(id))
    {
        return channel
            .keys()
            .copied()
            .filter(|peer| *peer != sid)
            .collect();
    }
    live.calls.peers(sid, user)
}

pub(crate) fn register(socket: &SocketRef, user: &Session, state: &AppState) {
    socket.on_disconnect(disconnected);
    direct_calls::register(socket);
    stream_rooms::register(
        socket,
        user,
        Arc::clone(&state.stream_rooms),
        Arc::clone(&state.ice),
    );
    socket.on("entrar-canal", join_text);
    socket.on("sair-canal", leave_text);
    socket.on(
        "enviar-mensagem",
        async |io: SocketIo,
               State(state): State<Arc<AppState>>,
               Extension(user): Extension<Session>,
               TryData(data): TryData<Value>| {
            if let Ok(data) = data {
                log_error(send_text(&io, &state, &user, data).await);
            }
        },
    );
    socket.on(
        "apagar-mensagem",
        async |io: SocketIo,
               State(state): State<Arc<AppState>>,
               Extension(user): Extension<Session>,
               TryData(data): TryData<Value>| {
            if let Ok(data) = data {
                log_error(delete_text(&io, &state, &user, data).await);
            }
        },
    );
    socket.on("entrar-canal-voz", join_voice);
    socket.on("sair-canal-voz", leave_voice);
    socket.on("obter-presenca-servidor", voice_snapshot);
    socket.on("expulsar-da-call", kick_voice);
    socket.on(
        "tela-parada",
        async |socket: SocketRef,
               io: SocketIo,
               State(state): State<Arc<AppState>>,
               Extension(user): Extension<Session>| {
            for peer in voice_peers(&state, socket.id, user.id) {
                emit(
                    &io,
                    peer,
                    "tela-parada",
                    &json!({ "socketId": socket.id.to_string() }),
                );
            }
        },
    );
    for (event, field) in [
        ("webrtc-oferta", "oferta"),
        ("webrtc-resposta", "resposta"),
        ("webrtc-candidato", "candidato"),
    ] {
        socket.on(
            event,
            move |socket: SocketRef,
                  io: SocketIo,
                  State(state): State<Arc<AppState>>,
                  Extension(user): Extension<Session>,
                  TryData(data): TryData<Value>| async move {
                let Ok(data) = data else {
                    return;
                };
                let Some(target) = data
                    .get("para")
                    .and_then(Value::as_str)
                    .and_then(|id| id.parse::<Sid>().ok())
                else {
                    return;
                };
                if socket.connected() && voice_peers(&state, socket.id, user.id).contains(&target) {
                    let mut forwarded = Map::new();
                    forwarded.insert("de".into(), json!(socket.id.to_string()));
                    if let Some(payload) = data.get(field) {
                        forwarded.insert(field.into(), payload.clone());
                    }
                    emit(&io, target, event, &forwarded);
                }
            },
        );
    }
}
