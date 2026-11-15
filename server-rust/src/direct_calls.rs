use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use serde::Serialize;
use serde_json::{Value, json};
use socketioxide::{
    SocketIo,
    extract::{AckSender, SocketRef, State, TryData},
    socket::Sid,
};
use sqlx::PgPool;
use tokio::task::AbortHandle;

use crate::{
    AppState, Session,
    accounts::are_friends,
    realtime::{Participant, emit, externally_busy, lock, user_room, wire_id},
};

pub(crate) const DIRECT_PREFIX: &str = "direta:";

#[derive(Clone, Serialize, sqlx::FromRow)]
pub(crate) struct Profile {
    pub(crate) id: i64,
    pub(crate) nome: String,
    pub(crate) avatar_cor: Option<String>,
    pub(crate) avatar_url: Option<String>,
}

impl Profile {
    pub(crate) async fn load(db: &PgPool, id: i64) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as(
            "SELECT id, nome, NULLIF(avatar_cor, '') AS avatar_cor,
            NULLIF(avatar_url, '') AS avatar_url FROM usuarios WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(db)
        .await
    }

    pub(crate) fn participant(&self, socket_id: Sid, default_color: &str) -> Participant {
        Participant {
            socket_id: socket_id.to_string(),
            usuario_id: self.id,
            nome: self.nome.clone(),
            avatar_cor: self
                .avatar_cor
                .clone()
                .unwrap_or_else(|| default_color.to_owned()),
            avatar_url: self.avatar_url.clone(),
        }
    }
}

struct Call {
    id: String,
    caller: Profile,
    callee: Profile,
    caller_socket: Sid,
    callee_socket: Option<Sid>,
    ringing: HashSet<Sid>,
    joined: HashMap<Sid, Participant>,
    timeout: Option<AbortHandle>,
}

impl Call {
    fn summary(&self) -> Value {
        json!({
            "id": self.id, "canalId": format!("{DIRECT_PREFIX}{}", self.id),
            "status": if self.callee_socket.is_some() { "active" } else { "ringing" },
            "caller": self.caller, "callee": self.callee,
        })
    }

    fn selected(&self, sid: Sid) -> bool {
        self.callee_socket
            .is_some_and(|callee| sid == self.caller_socket || sid == callee)
    }
}

#[derive(Default)]
pub(crate) struct Calls {
    calls: HashMap<String, Call>,
    by_user: HashMap<i64, String>,
}

impl Calls {
    pub(crate) fn is_busy(&self, user: i64) -> bool {
        self.by_user.contains_key(&user)
    }

    fn finish(&mut self, io: &SocketIo, call_id: &str, reason: &str) {
        let Some(mut call) = self.calls.remove(call_id) else {
            return;
        };
        self.by_user.remove(&call.caller.id);
        self.by_user.remove(&call.callee.id);
        if let Some(timer) = call.timeout.take() {
            timer.abort();
        }
        let mut notified = call.ringing;
        notified.insert(call.caller_socket);
        notified.extend(call.callee_socket);
        for sid in call.joined.keys() {
            for peer in call.joined.keys().filter(|peer| *peer != sid) {
                emit(
                    io,
                    *peer,
                    "peer-saiu",
                    &json!({ "socketId": sid.to_string() }),
                );
            }
        }
        for sid in notified {
            emit(
                io,
                sid,
                "chamada:encerrada",
                &json!({ "callId": call.id, "reason": reason }),
            );
        }
    }

    pub(crate) fn reconnect(&mut self, socket: &SocketRef, user: i64) {
        let Some(call) = self
            .by_user
            .get(&user)
            .and_then(|id| self.calls.get_mut(id))
        else {
            return;
        };
        if user == call.callee.id && call.callee_socket.is_none() {
            call.ringing.insert(socket.id);
            let _ = socket.emit("chamada:recebida", &json!({ "call": call.summary() }));
        }
    }

    pub(crate) fn disconnect(&mut self, io: &SocketIo, sid: Sid, user: i64) {
        let Some(call) = self
            .by_user
            .get(&user)
            .and_then(|id| self.calls.get_mut(id))
        else {
            return;
        };
        let ended = sid == call.caller_socket
            || call.callee_socket == Some(sid)
            || (user == call.callee.id && call.callee_socket.is_none() && {
                call.ringing.remove(&sid);
                call.ringing.is_empty()
            });
        if ended {
            let id = call.id.clone();
            self.finish(io, &id, "disconnected");
        }
    }

    pub(crate) fn join_voice(&mut self, io: &SocketIo, socket: &SocketRef, channel: &str) -> Value {
        let id = channel.strip_prefix(DIRECT_PREFIX).unwrap_or_default();
        let Some(call) = self
            .calls
            .get_mut(id)
            .filter(|call| call.selected(socket.id))
        else {
            return failure("forbidden", "Esta chamada não está disponível.");
        };
        let peers: Vec<_> = call
            .joined
            .values()
            .filter(|peer| peer.socket_id != socket.id.to_string())
            .cloned()
            .collect();
        let profile = if socket.id == call.caller_socket {
            &call.caller
        } else {
            &call.callee
        };
        let participant = profile.participant(socket.id, "#9270f4");
        let previous = call.joined.insert(socket.id, participant.clone());
        let _ = socket.emit("peers-existentes", &json!({ "peers": peers }));
        if previous.is_none() {
            for sid in call.joined.keys().filter(|sid| **sid != socket.id) {
                emit(io, *sid, "novo-peer", &participant);
            }
        }
        json!({ "ok": true })
    }

    pub(crate) fn leave_voice(&mut self, io: &SocketIo, sid: Sid, user: i64) -> bool {
        let Some(id) = self.by_user.get(&user).cloned() else {
            return false;
        };
        if self
            .calls
            .get(&id)
            .is_some_and(|call| call.joined.contains_key(&sid) && call.selected(sid))
        {
            self.finish(io, &id, "ended");
            return true;
        }
        false
    }

    pub(crate) fn peers(&self, sid: Sid, user: i64) -> Vec<Sid> {
        self.by_user
            .get(&user)
            .and_then(|id| self.calls.get(id))
            .filter(|call| call.selected(sid) && call.joined.contains_key(&sid))
            .map(|call| {
                call.joined
                    .keys()
                    .copied()
                    .filter(|other| *other != sid)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn relevant_pairs(&self, users: &[i64]) -> Vec<(String, i64, i64)> {
        users
            .iter()
            .filter_map(|user| self.by_user.get(user))
            .collect::<HashSet<_>>()
            .into_iter()
            .filter_map(|id| self.calls.get(id))
            .map(|call| (call.id.clone(), call.caller.id, call.callee.id))
            .collect()
    }

    pub(crate) fn friendship_removed(&mut self, io: &SocketIo, id: &str) {
        self.finish(io, id, "friendship-removed");
    }
}

fn failure(code: &str, error: &str) -> Value {
    json!({ "ok": false, "code": code, "error": error })
}

async fn start(
    io: &SocketIo,
    state: &Arc<AppState>,
    socket: &SocketRef,
    user: &Session,
    input: &Value,
) -> Result<Value, sqlx::Error> {
    let Some(target) = input
        .get("paraUsuarioId")
        .and_then(wire_id)
        .filter(|id| *id != user.id)
    else {
        return Ok(failure("invalid", "Escolha um amigo para ligar."));
    };
    {
        let live = lock(state);
        if live.calls.is_busy(user.id) || externally_busy(state, io, &live, user.id) {
            return Ok(failure("busy", "Encerre sua chamada atual antes de ligar."));
        }
    }
    if !are_friends(&state.db, user.id, target).await? {
        return Ok(failure(
            "not-friends",
            "Adicione esta pessoa aos amigos antes de ligar.",
        ));
    }
    let (caller, callee) = tokio::try_join!(
        Profile::load(&state.db, user.id),
        Profile::load(&state.db, target)
    )?;
    let (Some(mut caller), Some(mut callee)) = (caller, callee) else {
        return Ok(failure("not-found", "Esta conta não está disponível."));
    };
    for profile in [&mut caller, &mut callee] {
        profile.avatar_cor.get_or_insert_with(|| "#9270f4".into());
    }
    let mut live = lock(state);
    if !socket.connected() {
        return Ok(failure(
            "disconnected",
            "Você se desconectou. Tente ligar novamente.",
        ));
    }
    if [user.id, target]
        .iter()
        .any(|id| live.calls.is_busy(*id) || externally_busy(state, io, &live, *id))
    {
        return Ok(failure("busy", "Um de vocês já está em uma chamada."));
    }
    let recipients: HashSet<_> = io
        .within(user_room(target))
        .sockets()
        .into_iter()
        .filter(|item| item.connected())
        .map(|item| item.id)
        .collect();
    if recipients.is_empty() {
        return Ok(failure("offline", "Seu amigo está offline."));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let timer = {
        let (state, io, id) = (Arc::clone(state), io.clone(), id.clone());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let mut live = lock(&state);
            if live
                .calls
                .calls
                .get(&id)
                .is_some_and(|call| call.callee_socket.is_none())
            {
                live.calls.finish(&io, &id, "timeout");
            }
        })
        .abort_handle()
    };
    let call = Call {
        id: id.clone(),
        caller,
        callee,
        caller_socket: socket.id,
        callee_socket: None,
        ringing: recipients,
        joined: HashMap::new(),
        timeout: Some(timer),
    };
    let summary = call.summary();
    let event = json!({ "call": summary });
    let _ = socket.emit("chamada:estado", &event);
    for sid in &call.ringing {
        emit(io, *sid, "chamada:recebida", &event);
    }
    live.calls.by_user.insert(user.id, id.clone());
    live.calls.by_user.insert(target, id.clone());
    live.calls.calls.insert(id, call);
    Ok(json!({ "ok": true, "call": summary }))
}

async fn accept(
    io: &SocketIo,
    state: &AppState,
    socket: &SocketRef,
    user: &Session,
    id: &str,
) -> Result<Value, sqlx::Error> {
    let (caller_id, callee_id) = {
        let live = lock(state);
        let Some(call) = live.calls.calls.get(id) else {
            return Ok(failure("not-found", "Esta chamada já terminou."));
        };
        if user.id != call.callee.id || !call.ringing.contains(&socket.id) || !socket.connected() {
            return Ok(failure(
                "forbidden",
                "Esta chamada não foi enviada para você.",
            ));
        }
        if call.callee_socket.is_some() {
            return Ok(failure("busy", "Esta chamada já foi atendida."));
        }
        (call.caller.id, call.callee.id)
    };
    let still_friends = are_friends(&state.db, caller_id, callee_id).await?;
    let mut live = lock(state);
    if !still_friends {
        live.calls.friendship_removed(io, id);
        return Ok(failure("not-friends", "A amizade foi removida."));
    }
    let Some(call) = live.calls.calls.get(id) else {
        return Ok(failure("not-found", "Esta chamada já terminou."));
    };
    if call.callee_socket.is_some() {
        return Ok(failure("busy", "Esta chamada já foi atendida."));
    }
    if !socket.connected()
        || !io
            .get_socket(call.caller_socket)
            .is_some_and(|item| item.connected())
    {
        return Ok(failure("disconnected", "Um de vocês se desconectou."));
    }
    if externally_busy(state, io, &live, caller_id) || externally_busy(state, io, &live, callee_id)
    {
        live.calls.finish(io, id, "busy");
        return Ok(failure("busy", "Um de vocês já está em outra chamada."));
    }
    let call = live
        .calls
        .calls
        .get_mut(id)
        .expect("chamada verificada com a trava mantida");
    if let Some(timer) = call.timeout.take() {
        timer.abort();
    }
    call.callee_socket = Some(socket.id);
    let summary = call.summary();
    let event = json!({ "call": summary });
    emit(io, call.caller_socket, "chamada:estado", &event);
    let _ = socket.emit("chamada:estado", &event);
    for sid in call.ringing.iter().filter(|sid| **sid != socket.id) {
        emit(
            io,
            *sid,
            "chamada:encerrada",
            &json!({ "callId": id, "reason": "answered-elsewhere" }),
        );
    }
    call.ringing.retain(|sid| *sid == socket.id);
    Ok(json!({ "ok": true, "call": summary }))
}

fn end(
    io: &SocketIo,
    state: &AppState,
    socket: &SocketRef,
    user: &Session,
    id: &str,
    reason: &str,
) -> Value {
    let mut live = lock(state);
    let Some(call) = live.calls.calls.get(id) else {
        return failure("not-found", "Esta chamada já terminou.");
    };
    let active = call.callee_socket.is_some();
    let allowed = socket.connected()
        && match reason {
            "cancelled" => socket.id == call.caller_socket,
            "declined" => user.id == call.callee.id && call.ringing.contains(&socket.id),
            _ => call.selected(socket.id),
        };
    if !allowed {
        return failure("forbidden", "Esta chamada não pertence a esta sessão.");
    }
    live.calls
        .finish(io, id, if active { "ended" } else { reason });
    json!({ "ok": true })
}

pub(crate) fn register(socket: &SocketRef) {
    for (event, action) in [
        ("chamada:iniciar", "start"),
        ("chamada:aceitar", "accept"),
        ("chamada:recusar", "declined"),
        ("chamada:cancelar", "cancelled"),
        ("chamada:encerrar", "ended"),
    ] {
        socket.on(
            event,
            move |socket: SocketRef,
                  io: SocketIo,
                  State(state): State<Arc<AppState>>,
                  socketioxide::extract::Extension(user): socketioxide::extract::Extension<
                Session,
            >,
                  TryData(input): TryData<Value>,
                  ack: AckSender| async move {
                let input = input.unwrap_or(Value::Null);
                let id = input
                    .get("callId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let result = match action {
                    "start" => start(&io, &state, &socket, &user, &input).await,
                    "accept" => accept(&io, &state, &socket, &user, id).await,
                    _ => Ok(end(&io, &state, &socket, &user, id, action)),
                };
                let result = result.unwrap_or_else(|error| {
                    eprintln!("Erro em chamada direta: {error}");
                    failure(
                        "unavailable",
                        "Não foi possível completar a chamada. Tente novamente.",
                    )
                });
                let _ = ack.send(&result);
            },
        );
    }
}
