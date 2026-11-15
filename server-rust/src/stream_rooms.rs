use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use socketioxide::{
    SocketIo,
    extract::{AckSender, SocketRef, TryData},
    socket::Sid,
};
use subtle::ConstantTimeEq;

use crate::{Session, ice::IceConfig};

const HOST_RECONNECT_GRACE: Duration = Duration::from_secs(30);
const INACTIVE: &str = "Esta sala não está mais ativa.";
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Default)]
pub(crate) struct StreamRooms(Mutex<Rooms>);

#[derive(Default)]
struct Rooms {
    by_id: HashMap<String, Room>,
    by_socket: HashMap<Sid, String>,
    next_order: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Presenter {
    socket_id: Sid,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Playback {
    action: &'static str,
    current_time: f64,
    updated_at: String,
    revision: u64,
}

struct Room {
    id: String,
    order: u64,
    name: String,
    owner_name: String,
    owner_id: i64,
    owner_socket: Sid,
    owner_disconnect_timer: Option<tokio::task::AbortHandle>,
    reserved_index: Option<usize>,
    access_code: Option<String>,
    viewers: Vec<(Sid, String)>,
    presenters: Vec<Presenter>,
    youtube_video: Option<String>,
    youtube_playback: Playback,
    created_at: String,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn make_code() -> Option<String> {
    let mut random = [0; 8];
    getrandom::fill(&mut random).ok()?;
    Some(
        random
            .into_iter()
            .map(|byte| CODE_ALPHABET[(byte & 31) as usize] as char)
            .collect(),
    )
}

fn compare_code(input: &str, expected: &str) -> bool {
    let normalized = input.trim().to_uppercase();
    bool::from(normalized.as_bytes().ct_eq(expected.as_bytes()))
}

fn member_name(name: &str, fallback: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        return fallback.to_owned();
    }
    let mut len = 0;
    name.chars()
        .take_while(|ch| {
            len += ch.len_utf16();
            len <= 32
        })
        .collect()
}

impl Room {
    fn channel(&self) -> String {
        room_channel(&self.id)
    }

    fn is_presenter(&self, socket_id: Sid) -> bool {
        self.presenters
            .iter()
            .any(|presenter| presenter.socket_id == socket_id)
    }

    fn remove_presenter(&mut self, socket_id: Sid) -> Option<(usize, Presenter)> {
        let index = self
            .presenters
            .iter()
            .position(|presenter| presenter.socket_id == socket_id)?;
        Some((index, self.presenters.remove(index)))
    }

    fn presenter_id(&self) -> Option<Sid> {
        self.presenters.first().map(|presenter| presenter.socket_id)
    }

    fn presenter_name(&self) -> Option<&str> {
        self.presenters
            .first()
            .map(|presenter| presenter.name.as_str())
    }

    fn viewer_ids(&self) -> impl Iterator<Item = Sid> + '_ {
        self.viewers.iter().map(|(id, _)| *id)
    }

    fn peers(&self, socket_id: Sid) -> Vec<Sid> {
        std::iter::once(self.owner_socket)
            .chain(self.viewer_ids())
            .filter(|id| *id != socket_id)
            .collect()
    }

    fn notify_ids(&self) -> Vec<Sid> {
        if self.presenters.is_empty() {
            vec![self.owner_socket]
        } else {
            self.presenters.iter().map(|p| p.socket_id).collect()
        }
    }

    fn summary(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "ownerName": self.owner_name,
            "visibility": if self.access_code.is_some() {"private"} else {"public"},
            "isLive": !self.presenters.is_empty(), "presenterSocketId": self.presenter_id(),
            "presenterName": self.presenter_name(), "presenters": self.presenters,
            "reservedPresenterSlot": self.reserved_index.is_some(), "viewerCount": self.viewers.len(),
            "createdAt": self.created_at,
        })
    }

    fn youtube_source(&self) -> Value {
        self.youtube_video
            .as_ref()
            .map_or(Value::Null, |video_id| json!({ "videoId": video_id }))
    }

    fn youtube_state(&self) -> Value {
        json!({"salaId": self.id, "source": self.youtube_source(), "playback": self.youtube_playback})
    }

    fn entry(&self, socket_id: Sid) -> Value {
        let is_host = self.owner_socket == socket_id;
        let peer_ids = if self.is_presenter(socket_id) {
            self.peers(socket_id)
        } else if !self.presenters.is_empty() {
            self.notify_ids()
        } else if is_host {
            self.viewer_ids().collect()
        } else {
            vec![self.owner_socket]
        };
        let mut result = json!({
            "ok": true, "room": self.summary(), "role": if is_host {"host"} else {"viewer"},
            "hostSocketId": self.owner_socket, "peerSocketIds": peer_ids,
            "presenterSocketId": self.presenter_id(), "presenterName": self.presenter_name(),
            "presenters": self.presenters, "youtubeSource": self.youtube_source(),
            "youtubePlayback": self.youtube_playback,
        });
        if let Some(code) = self.access_code.as_ref().filter(|_| is_host) {
            result["accessCode"] = json!(code);
        }
        result
    }

    fn transmission(&self, previous: Option<&Presenter>, with_previous: bool) -> Value {
        let mut report = json!({
            "salaId": self.id, "isLive": !self.presenters.is_empty(),
            "presenterSocketId": self.presenter_id(), "presenterName": self.presenter_name(),
            "presenters": self.presenters,
        });
        if with_previous {
            report["previousPresenterSocketId"] = json!(previous.map(|p| p.socket_id));
            report["previousPresenterName"] = json!(previous.map(|p| &p.name));
        }
        report
    }

    fn live_error(&self, message: &str) -> Value {
        json!({
            "ok": false, "error": message, "presenterSocketId": self.presenter_id(),
            "presenterName": self.presenter_name(), "presenters": self.presenters,
        })
    }

    fn emit_state(&self, io: &SocketIo) {
        emit_room(
            io,
            &self.channel(),
            "sala:estado",
            &json!({ "sala": self.summary() }),
        );
    }
}

impl StreamRooms {
    pub(crate) fn contains_socket(&self, id: &str) -> bool {
        id.parse::<Sid>()
            .ok()
            .is_some_and(|id| self.0.lock().unwrap().by_socket.contains_key(&id))
    }
}

impl Rooms {
    fn list(&self) -> Vec<Value> {
        let mut rooms: Vec<_> = self
            .by_id
            .values()
            .filter(|room| room.access_code.is_none() && !room.presenters.is_empty())
            .collect();
        rooms.sort_unstable_by_key(|room| room.order);
        rooms.into_iter().map(Room::summary).collect()
    }

    fn publish(&self, io: &SocketIo) {
        let data = json!({ "rooms": self.list() });
        for socket in io.sockets() {
            let _ = socket.emit("salas:atualizadas", &data);
        }
    }

    fn admitted_room(&mut self, socket: &SocketRef, room_id: &str) -> Option<&mut Room> {
        if self
            .by_socket
            .get(&socket.id)
            .is_some_and(|id| id == room_id)
            && in_channel(socket, &room_channel(room_id))
        {
            self.by_id.get_mut(room_id)
        } else {
            None
        }
    }

    fn create(
        &mut self,
        socket: &SocketRef,
        user: &Session,
        details: &Value,
    ) -> Result<Value, Value> {
        if self.by_socket.contains_key(&socket.id) {
            return Err(error("Você já está em uma sala."));
        }
        let name = details["name"].as_str().unwrap_or("").trim();
        if name.is_empty() || name.encode_utf16().count() > 60 {
            return Err(error("O nome deve ter entre 1 e 60 caracteres."));
        }
        let access_code = match details["visibility"].as_str() {
            Some("public") => None,
            Some("private") => {
                let code = (0..8).filter_map(|_| make_code()).find(|candidate| {
                    !self.by_id.values().any(|room| {
                        room.access_code
                            .as_ref()
                            .is_some_and(|code| compare_code(candidate, code))
                    })
                });
                Some(code.ok_or_else(|| {
                    error("Não foi possível gerar um código único para a sala. Tente novamente.")
                })?)
            }
            _ => return Err(error("Escolha se a sala será pública ou privada.")),
        };
        let id = uuid::Uuid::new_v4().to_string();
        if self.by_id.contains_key(&id) {
            return Err(error("Não foi possível criar um identificador de sala."));
        }
        let channel = room_channel(&id);
        if !join_channel(socket, &channel) {
            return Err(error("A conexão foi encerrada antes de abrir a sala."));
        }
        let created_at = now();
        let room = Room {
            id: id.clone(),
            order: self.next_order,
            name: name.to_owned(),
            owner_name: member_name(&user.nome, "Anfitrião"),
            owner_id: user.id,
            owner_socket: socket.id,
            owner_disconnect_timer: None,
            reserved_index: None,
            access_code,
            viewers: Vec::new(),
            presenters: Vec::new(),
            youtube_video: None,
            youtube_playback: Playback {
                action: "pause",
                current_time: 0.0,
                updated_at: created_at.clone(),
                revision: 0,
            },
            created_at,
        };
        self.next_order += 1;
        let mut result = room.entry(socket.id);
        result.as_object_mut().unwrap().remove("hostSocketId");
        self.by_socket.insert(socket.id, id.clone());
        self.by_id.insert(id, room);
        Ok(result)
    }

    fn join(
        &mut self,
        socket: &SocketRef,
        user: &Session,
        details: &Value,
    ) -> Result<Entry, Value> {
        let has_room_id = truthy(details.get("roomId"));
        let access_code = details["accessCode"].as_str();
        let room_id = if has_room_id {
            details["roomId"].as_str().map(str::to_owned)
        } else {
            access_code
                .and_then(|code| {
                    self.by_id.values().find(|room| {
                        room.access_code
                            .as_ref()
                            .is_some_and(|expected| compare_code(code, expected))
                    })
                })
                .map(|room| room.id.clone())
        };
        let room = room_id
            .and_then(|id| self.by_id.get_mut(&id))
            .ok_or_else(|| {
                error(if has_room_id {
                    INACTIVE
                } else {
                    "Código inválido ou sala encerrada."
                })
            })?;

        let channel = room.channel();
        let existing = self.by_socket.get(&socket.id);
        if let Some(existing) = existing {
            if existing != &room.id {
                return Err(error("Saia da outra sala antes de entrar nesta."));
            }
            if in_channel(socket, &channel) {
                return Ok(Entry {
                    room_id: room.id.clone(),
                    notify: false,
                    reconnected: false,
                    emit_state: false,
                    result: room.entry(socket.id),
                });
            }
        }
        let reconnected =
            room.owner_disconnect_timer.is_some() && user.id == room.owner_id && existing.is_none();
        if existing.is_none()
            && !reconnected
            && room.access_code.as_ref().is_some_and(|expected| {
                !access_code.is_some_and(|code| compare_code(code, expected))
            })
        {
            return Err(error("Código de acesso inválido."));
        }
        if !join_channel(socket, &channel) {
            return Err(error("A conexão foi encerrada antes de entrar na sala."));
        }
        let notify = existing.is_none() && !reconnected;
        if reconnected {
            self.by_socket.remove(&room.owner_socket);
            room.owner_socket = socket.id;
            if let Some(timer) = room.owner_disconnect_timer.take() {
                timer.abort();
            }
            if let Some(index) = room.reserved_index.take() {
                room.presenters.insert(
                    index.min(room.presenters.len()),
                    Presenter {
                        socket_id: socket.id,
                        name: room.owner_name.clone(),
                    },
                );
            }
        } else if notify {
            room.viewers
                .push((socket.id, member_name(&user.nome, "Visitante")));
        }
        self.by_socket.insert(socket.id, room.id.clone());
        let mut result = room.entry(socket.id);
        result["hostReconnected"] = json!(reconnected);
        Ok(Entry {
            room_id: room.id.clone(),
            notify,
            reconnected,
            emit_state: true,
            result,
        })
    }

    fn close(&mut self, room_id: &str, owner: Sid) -> Result<Room, Value> {
        let room = self.by_id.get(room_id).ok_or_else(|| error(INACTIVE))?;
        if room.owner_socket != owner || self.by_socket.get(&owner).is_none_or(|id| id != room_id) {
            return Err(error("Somente o anfitrião pode encerrar a sala."));
        }
        self.by_socket.remove(&owner);
        for viewer in room.viewer_ids() {
            self.by_socket.remove(&viewer);
        }
        let mut room = self.by_id.remove(room_id).unwrap();
        if let Some(timer) = room.owner_disconnect_timer.take() {
            timer.abort();
        }
        Ok(room)
    }

    fn announce_close(&self, io: &SocketIo, room: &Room) {
        let channel = room.channel();
        let sockets = io.within(channel.clone()).sockets();
        for presenter in &room.presenters {
            let data = json!({
                "salaId": room.id, "isLive": false, "presenterSocketId": null,
                "presenterName": null, "presenters": [],
                "previousPresenterSocketId": presenter.socket_id, "previousPresenterName": presenter.name,
            });
            for socket in &sockets {
                let _ = socket.emit("sala:transmissao", &data);
            }
        }
        let data = json!({ "salaId": room.id });
        for socket in sockets {
            let _ = socket.emit("sala:encerrada", &data);
            socket.leave(channel.clone());
        }
        self.publish(io);
    }

    fn leave(&mut self, socket: &SocketRef, io: &SocketIo) -> Value {
        let Some(room_id) = self.by_socket.get(&socket.id).cloned() else {
            return error("Você não está em uma sala.");
        };
        let Some(room) = self.by_id.get_mut(&room_id) else {
            self.by_socket.remove(&socket.id);
            return error(INACTIVE);
        };
        if room.owner_socket == socket.id {
            return match self.close(&room_id, socket.id) {
                Ok(room) => {
                    self.announce_close(io, &room);
                    close_result(&room)
                }
                Err(error) => error,
            };
        }

        self.by_socket.remove(&socket.id);
        room.viewers.retain(|(viewer, _)| *viewer != socket.id);
        let previous = room
            .remove_presenter(socket.id)
            .map(|(_, presenter)| presenter);
        let channel = room.channel();
        socket.leave(channel.clone());
        if let Some(previous) = &previous {
            emit_room(
                io,
                &channel,
                "sala:transmissao",
                &room.transmission(Some(previous), true),
            );
        }
        let data = json!({"salaId": room.id, "socketId": socket.id});
        for id in room.notify_ids().into_iter().filter(|id| *id != socket.id) {
            if let Some(peer) = io.get_socket(id) {
                let _ = peer.emit("sala:espectador-saiu", &data);
            }
        }
        room.emit_state(io);
        let result = json!({
            "ok": true, "closed": false, "roomId": room.id, "hostSocketId": room.owner_socket,
            "presenterSocketId": room.presenter_id(), "presenterName": room.presenter_name(),
            "presenters": room.presenters, "transmissionStopped": previous.is_some(),
            "previousPresenterSocketId": previous.as_ref().map(|p| p.socket_id),
            "previousPresenterName": previous.as_ref().map(|p| &p.name), "room": room.summary(),
        });
        self.publish(io);
        result
    }
}

struct Entry {
    room_id: String,
    notify: bool,
    reconnected: bool,
    emit_state: bool,
    result: Value,
}

fn room_channel(room_id: &str) -> String {
    format!("sala-{room_id}")
}

fn error(message: &str) -> Value {
    json!({"ok": false, "error": message})
}

fn reply(ack: AckSender, data: Value) {
    let _ = ack.send(&data);
}

fn in_channel(socket: &SocketRef, channel: &str) -> bool {
    socket.connected() && socket.rooms().iter().any(|room| room.as_ref() == channel)
}

fn join_channel(socket: &SocketRef, channel: &str) -> bool {
    if !socket.connected() {
        return false;
    }
    // The local adapter joins synchronously. Hold the state lock across this call
    // and confirm the socket is still present before publishing its membership.
    socket.join(channel.to_owned());
    if in_channel(socket, channel) {
        true
    } else {
        socket.leave(channel.to_owned());
        false
    }
}

fn emit_room(io: &SocketIo, channel: &str, event: &str, data: &Value) {
    for socket in io.within(channel.to_owned()).sockets() {
        let _ = socket.emit(event, data);
    }
}

fn close_result(room: &Room) -> Value {
    json!({
        "ok": true, "closed": true, "roomId": room.id, "hostSocketId": room.owner_socket,
        "viewerSocketIds": room.viewer_ids().collect::<Vec<_>>(),
        "presenterSocketId": room.presenter_id(), "presenterName": room.presenter_name(),
        "presenters": room.presenters,
    })
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Number(value)) => value.as_f64().is_some_and(|value| value != 0.0),
        Some(_) => true,
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Offer,
    Answer,
    Candidate,
}

impl Signal {
    fn event(self) -> &'static str {
        match self {
            Self::Offer => "sala:sinal:oferta",
            Self::Answer => "sala:sinal:resposta",
            Self::Candidate => "sala:sinal:candidato",
        }
    }

    fn payload_key(self) -> &'static str {
        match self {
            Self::Offer => "descricao",
            Self::Answer => "resposta",
            Self::Candidate => "candidato",
        }
    }

    fn belongs_to(self, stream: Sid, from: Sid, to: Sid) -> bool {
        match self {
            Self::Offer => stream == from,
            Self::Answer => stream == to,
            Self::Candidate => stream == from || stream == to,
        }
    }

    fn resolve(
        self,
        room: &Room,
        requested: Option<&Value>,
        from: Sid,
        to: Option<Sid>,
    ) -> Option<Sid> {
        if let Some(requested) = requested {
            let stream = requested.as_str()?.parse().ok()?;
            return room.is_presenter(stream).then_some(stream);
        }
        if room.presenters.len() == 1 {
            return room.presenter_id();
        }
        // Older clients omit the stream ID; infer it from the signal direction.
        let inferred = match self {
            Self::Offer => from,
            Self::Answer => to?,
            Self::Candidate if room.is_presenter(from) => from,
            Self::Candidate => to?,
        };
        room.is_presenter(inferred).then_some(inferred)
    }
}

fn relay(
    rooms: &Rooms,
    socket: &SocketRef,
    io: &SocketIo,
    details: &Value,
    signal: Signal,
) -> Value {
    let key = signal.payload_key();
    let room_id = details["roomId"].as_str().unwrap_or("");
    let from = socket.id;
    let Some(to) = details["para"].as_str() else {
        return error("Sinalização inválida.");
    };
    if !truthy(details.get("roomId")) || !(truthy(details.get("dados")) || truthy(details.get(key)))
    {
        return error("Sinalização inválida.");
    }
    let to = to.parse::<Sid>().ok();
    let Some(room) = rooms.by_id.get(room_id) else {
        return error("Transmissão inválida ou ambígua.");
    };
    let Some(stream_id) = signal.resolve(room, details.get("streamId"), from, to) else {
        return error("Transmissão inválida ou ambígua.");
    };
    let Some(to) = to else {
        return error("Este destino não pertence à sua sala.");
    };
    if from == to
        || !signal.belongs_to(stream_id, from, to)
        || rooms.by_socket.get(&from).is_none_or(|id| id != room_id)
        || rooms.by_socket.get(&to).is_none_or(|id| id != room_id)
    {
        return error("Este destino não pertence à sua sala.");
    }
    let channel = room.channel();
    let Some(peer) = io.get_socket(to).filter(|peer| in_channel(peer, &channel)) else {
        return error("Este destino não está conectado à sala.");
    };
    if !in_channel(socket, &channel) {
        return error("Este destino não está conectado à sala.");
    }
    let payload = details
        .get(key)
        .filter(|value| !value.is_null())
        .or_else(|| details.get("dados"))
        .unwrap_or(&Value::Null);
    let data = json!({"roomId": room_id, "de": from, "streamId": stream_id, key: payload});
    let _ = peer.emit(signal.event(), &data);
    json!({"ok": true, "streamId": stream_id})
}

#[derive(Clone, Copy)]
enum Event {
    List,
    Create,
    Join,
    Ice,
    Ready,
    Live,
    Source,
    Playback,
    Close,
    Leave,
    Relay(Signal),
}

fn set_live(room: &mut Room, io: &SocketIo, socket_id: Sid, is_live: Option<bool>) -> Value {
    let Some(is_live) = is_live else {
        return error("O estado da transmissão é inválido.");
    };
    let mut previous = None;
    if is_live {
        if room.youtube_video.is_some() {
            return error("Remova a fonte do YouTube antes de iniciar uma transmissão de tela.");
        }
        if !room.is_presenter(socket_id) {
            if room.presenters.len() + usize::from(room.reserved_index.is_some()) >= 2 {
                return room.live_error(
                    "Já existem duas transmissões nesta sala ou uma vaga reservada ao anfitrião.",
                );
            }
            let name = if socket_id == room.owner_socket {
                room.owner_name.clone()
            } else {
                room.viewers
                    .iter()
                    .find(|(id, _)| *id == socket_id)
                    .map_or_else(|| "Visitante".to_owned(), |(_, name)| name.clone())
            };
            room.presenters.push(Presenter { socket_id, name });
        }
    } else {
        previous = room
            .remove_presenter(socket_id)
            .map(|(_, presenter)| presenter);
        if previous.is_none() && !room.presenters.is_empty() {
            return room.live_error("Somente quem está transmitindo pode parar a transmissão.");
        }
    }
    emit_room(
        io,
        &room.channel(),
        "sala:transmissao",
        &room.transmission(previous.as_ref(), true),
    );
    room.emit_state(io);
    json!({
        "ok": true, "room": room.summary(), "peerSocketIds": room.peers(socket_id),
        "presenterSocketId": room.presenter_id(), "presenterName": room.presenter_name(),
        "presenters": room.presenters, "previousPresenterSocketId": previous.as_ref().map(|p| p.socket_id),
        "previousPresenterName": previous.as_ref().map(|p| &p.name),
    })
}

fn spectator_ready(room: &Room, io: &SocketIo, socket_id: Sid, details: &Value) -> Value {
    let restart = details["restart"].as_bool() == Some(true);
    let requested = match details.get("streamId") {
        None if !restart => None,
        supplied => match supplied
            .and_then(Value::as_str)
            .and_then(|id| id.parse::<Sid>().ok())
            .filter(|id| room.is_presenter(*id))
        {
            Some(id) => Some(id),
            None => return error("Transmissão indisponível para reconectar."),
        },
    };
    let mut data = json!({"salaId": room.id, "socketId": socket_id});
    if let Some(requested) = requested {
        data["streamId"] = json!(requested);
    }
    if restart {
        data["restart"] = json!(true);
    }
    for presenter in &room.presenters {
        if presenter.socket_id != socket_id
            && requested.is_none_or(|id| id == presenter.socket_id)
            && let Some(peer) = io.get_socket(presenter.socket_id)
        {
            let _ = peer.emit("sala:espectador-entrou", &data);
        }
    }
    json!({"ok": true, "presenterSocketId": room.presenter_id(), "presenters": room.presenters})
}

fn set_source(room: &mut Room, io: &SocketIo, socket_id: Sid, supplied: Option<&Value>) -> Value {
    if socket_id != room.owner_socket {
        return error("Somente o anfitrião pode alterar a fonte do YouTube.");
    }
    if supplied != Some(&Value::Null) && !room.presenters.is_empty() {
        return error("Pare a transmissão de tela antes de adicionar uma fonte do YouTube.");
    }
    let video_id = match supplied {
        Some(Value::Null) => None,
        Some(Value::String(id))
            if id.len() == 11
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-')) =>
        {
            Some(id.clone())
        }
        _ => return error("O identificador do vídeo do YouTube é inválido."),
    };
    room.youtube_playback = Playback {
        action: if video_id.is_some() { "play" } else { "pause" },
        current_time: 0.0,
        updated_at: now(),
        revision: room.youtube_playback.revision + 1,
    };
    room.youtube_video = video_id;
    emit_room(
        io,
        &room.channel(),
        "sala:youtube:estado",
        &room.youtube_state(),
    );
    json!({"ok": true, "source": room.youtube_source(), "playback": room.youtube_playback})
}

fn set_playback(room: &mut Room, io: &SocketIo, details: &Value) -> Value {
    if room.youtube_video.is_none() {
        return error("Não há uma fonte do YouTube nesta sala.");
    }
    let action = match details["action"].as_str() {
        Some("play") => "play",
        Some("pause") => "pause",
        Some("seek") if details.get("currentTime").is_some() => room.youtube_playback.action,
        Some("seek") => return error("Informe a posição do vídeo."),
        _ => return error("Ação de reprodução inválida."),
    };
    let position = match details.get("currentTime") {
        None => room.youtube_playback.current_time,
        Some(position) => match position
            .as_f64()
            .filter(|position| (0.0..=86400.0).contains(position))
        {
            Some(position) => position,
            None => return error("A posição do vídeo deve estar entre 0 e 86400 segundos."),
        },
    };
    room.youtube_playback = Playback {
        action,
        current_time: position,
        updated_at: now(),
        revision: room.youtube_playback.revision + 1,
    };
    emit_room(
        io,
        &room.channel(),
        "sala:youtube:reproducao",
        &json!({
            "salaId": room.id, "playback": room.youtube_playback,
        }),
    );
    json!({"ok": true, "source": room.youtube_source(), "playback": room.youtube_playback})
}

struct Connection {
    user: Session,
    rooms: Arc<StreamRooms>,
    ice: Arc<IceConfig>,
}

impl Connection {
    fn handle(&self, event: Event, socket: &SocketRef, io: &SocketIo, data: Value, ack: AckSender) {
        let mut rooms = self.rooms.0.lock().unwrap();
        let room_id = data["roomId"].as_str().unwrap_or("");
        let result = match event {
            Event::List => json!({"ok": true, "rooms": rooms.list()}),
            Event::Create => match rooms.create(socket, &self.user, &data) {
                Ok(result) => {
                    reply(ack, result);
                    rooms.publish(io);
                    return;
                }
                Err(err) => err,
            },
            Event::Join => match rooms.join(socket, &self.user, &data) {
                Ok(entry) => {
                    reply(ack, entry.result);
                    if entry.emit_state {
                        let room = &rooms.by_id[&entry.room_id];
                        let _ = socket.emit("sala:youtube:estado", &room.youtube_state());
                        if entry.notify {
                            let data = json!({"salaId": room.id, "socketId": socket.id});
                            for id in room.notify_ids().into_iter().filter(|id| *id != socket.id) {
                                if let Some(peer) = io.get_socket(id) {
                                    let _ = peer.emit("sala:espectador-entrou", &data);
                                }
                            }
                        }
                        if entry.reconnected {
                            emit_room(
                                io,
                                &room.channel(),
                                "sala:transmissao",
                                &room.transmission(None, false),
                            );
                            room.emit_state(io);
                        } else {
                            let _ = socket.emit("sala:estado", &json!({"sala": room.summary()}));
                        }
                        rooms.publish(io);
                    }
                    return;
                }
                Err(err) => err,
            },
            Event::Ice => {
                if rooms.admitted_room(socket, room_id).is_none() {
                    error("Entre na sala antes de configurar a conexão.")
                } else {
                    let mut config = self.ice.for_socket(&socket.id.to_string());
                    config["ok"] = json!(true);
                    config
                }
            }
            Event::Ready => match rooms.admitted_room(socket, room_id) {
                Some(room) => spectator_ready(room, io, socket.id, &data),
                None => error("Entre na sala antes de receber a transmissão."),
            },
            Event::Live => match rooms.admitted_room(socket, room_id) {
                Some(room) => {
                    let result = set_live(room, io, socket.id, data["isLive"].as_bool());
                    if result["ok"] == true {
                        rooms.publish(io);
                    }
                    result
                }
                None => error("Entre na sala antes de controlar a transmissão."),
            },
            Event::Source => match rooms.admitted_room(socket, room_id) {
                Some(room) => set_source(room, io, socket.id, data.get("videoId")),
                None => error("Entre na sala antes de alterar a fonte do YouTube."),
            },
            Event::Playback => match rooms.admitted_room(socket, room_id) {
                Some(room) => set_playback(room, io, &data),
                None => error("Entre na sala antes de controlar o vídeo."),
            },
            Event::Close => match rooms.close(room_id, socket.id) {
                Ok(room) => {
                    reply(ack, close_result(&room));
                    rooms.announce_close(io, &room);
                    return;
                }
                Err(err) => err,
            },
            Event::Leave => rooms.leave(socket, io),
            Event::Relay(signal) => relay(&rooms, socket, io, &data, signal),
        };
        reply(ack, result);
    }
}

pub(crate) fn register(
    socket: &SocketRef,
    user: &Session,
    rooms: Arc<StreamRooms>,
    ice: Arc<IceConfig>,
) {
    let connection = Arc::new(Connection {
        user: user.clone(),
        rooms,
        ice,
    });
    let events = [
        ("salas:listar", Event::List),
        ("salas:criar", Event::Create),
        ("salas:entrar", Event::Join),
        ("sala:ice-config", Event::Ice),
        ("sala:espectador-pronto", Event::Ready),
        ("salas:ao-vivo", Event::Live),
        ("sala:youtube:fonte", Event::Source),
        ("sala:youtube:reproducao", Event::Playback),
        ("salas:encerrar", Event::Close),
        ("salas:sair", Event::Leave),
        (Signal::Offer.event(), Event::Relay(Signal::Offer)),
        (Signal::Answer.event(), Event::Relay(Signal::Answer)),
        (Signal::Candidate.event(), Event::Relay(Signal::Candidate)),
    ];
    for (name, event) in events {
        let connection = Arc::clone(&connection);
        socket.on(
            name,
            move |socket: SocketRef,
                  io: SocketIo,
                  ack: AckSender,
                  TryData(data): TryData<Value>| {
                // Run the synchronous transition and writes in packet order. Socketioxide
                // spawns the returned future separately for each incoming packet.
                connection.handle(event, &socket, &io, data.unwrap_or(Value::Null), ack);
                std::future::ready(())
            },
        );
    }
}

pub(crate) fn disconnected(socket: &SocketRef, io: &SocketIo, stream_rooms: Arc<StreamRooms>) {
    let mut rooms = stream_rooms.0.lock().unwrap();
    let Some(room_id) = rooms.by_socket.get(&socket.id).cloned() else {
        return;
    };
    let Some(room) = rooms.by_id.get_mut(&room_id) else {
        return;
    };
    if room.owner_socket != socket.id {
        rooms.leave(socket, io);
        return;
    }
    let owner = socket.id;
    if room.owner_disconnect_timer.is_some() {
        return;
    }
    let timer_rooms = Arc::clone(&stream_rooms);
    let timer_io = io.clone();
    let timer = tokio::spawn(async move {
        tokio::time::sleep(HOST_RECONNECT_GRACE).await;
        let mut rooms = timer_rooms.0.lock().unwrap();
        let Some(room) = rooms.by_id.get_mut(&room_id) else {
            return;
        };
        if room.owner_socket == owner
            && room.owner_disconnect_timer.take().is_some()
            && let Ok(room) = rooms.close(&room_id, owner)
        {
            rooms.announce_close(&timer_io, &room);
        }
    });
    room.owner_disconnect_timer = Some(timer.abort_handle());
    if let Some((index, previous)) = room.remove_presenter(owner) {
        room.reserved_index = Some(index);
        emit_room(
            io,
            &room.channel(),
            "sala:transmissao",
            &room.transmission(Some(&previous), true),
        );
    }
    room.emit_state(io);
    rooms.publish(io);
}
