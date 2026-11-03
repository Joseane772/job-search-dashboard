"""Ligacao a conta Google: OAuth (PKCE), leitura do Gmail e do Calendar.

Cada pessoa usa o seu proprio cliente OAuth (tipo "Desktop app") criado na
Google Cloud; ver docs/google.md. Os scopes sao so de leitura. O token fica em
<dados>/google_token.json com permissoes 600 e nunca sai da maquina.
"""
import base64
import datetime
import hashlib
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
]
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events"

# Pesquisa do Gmail: tudo o que nao e promocao nem rede social, sem enviados.
CONSULTA = "-category:promotions -category:social -in:sent -in:chats"
PRIMEIRA_JANELA_DIAS = 30
MAX_MENSAGENS = 150


class ErroGoogle(Exception):
    pass


def _pedido(url, dados=None, token=None, metodo=None):
    cabecalhos = {"Accept": "application/json"}
    corpo = None
    if dados is not None:
        corpo = urllib.parse.urlencode(dados).encode()
        cabecalhos["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        cabecalhos["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=corpo, headers=cabecalhos, method=metodo)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            texto = r.read().decode("utf-8")
            return json.loads(texto) if texto else {}
    except urllib.error.HTTPError as e:
        detalhe = e.read().decode("utf-8", "replace")[:300]
        raise ErroGoogle("HTTP %d em %s: %s" % (e.code, url.split("?")[0], detalhe)) from None
    except urllib.error.URLError as e:
        raise ErroGoogle("sem ligacao a %s: %s" % (url.split("?")[0], e.reason)) from None


class Google:
    def __init__(self, pasta_dados):
        self.pasta = pasta_dados
        self.ficheiro_token = os.path.join(pasta_dados, "google_token.json")
        self.ficheiro_cliente = os.path.join(pasta_dados, "google_client.json")
        self.pendentes = {}  # state -> (verificador PKCE, redirect_uri, hora)

    # ---------- Configuracao ----------
    def cliente(self):
        """client_id e client_secret, do ambiente ou do JSON descarregado da Google Cloud."""
        cid = os.environ.get("GOOGLE_CLIENT_ID")
        segredo = os.environ.get("GOOGLE_CLIENT_SECRET")
        if cid and segredo:
            return cid, segredo
        try:
            with open(self.ficheiro_cliente, encoding="utf-8") as fh:
                dados = json.load(fh)
        except (OSError, ValueError):
            return None
        bloco = dados.get("installed") or dados.get("web") or dados
        if bloco.get("client_id") and bloco.get("client_secret"):
            return bloco["client_id"], bloco["client_secret"]
        return None

    def token(self):
        try:
            with open(self.ficheiro_token, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def _guardar_token(self, token):
        tmp = self.ficheiro_token + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(token, fh)
        os.replace(tmp, self.ficheiro_token)

    def estado(self):
        t = self.token()
        return {
            "configurado": self.cliente() is not None,
            "ligado": bool(t and t.get("refresh_token")),
            "conta": (t or {}).get("conta"),
        }

    # ---------- OAuth ----------
    def url_autorizacao(self, redirect_uri):
        cliente = self.cliente()
        if not cliente:
            raise ErroGoogle("cliente OAuth nao configurado")
        agora = time.time()
        self.pendentes = {k: v for k, v in self.pendentes.items() if agora - v[2] < 900}
        state = secrets.token_urlsafe(24)
        verificador = secrets.token_urlsafe(64)
        desafio = base64.urlsafe_b64encode(hashlib.sha256(verificador.encode()).digest()).rstrip(b"=").decode()
        self.pendentes[state] = (verificador, redirect_uri, agora)
        return AUTH_URL + "?" + urllib.parse.urlencode({
            "client_id": cliente[0],
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(SCOPES),
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
            "state": state,
            "code_challenge": desafio,
            "code_challenge_method": "S256",
        })

    def concluir(self, state, codigo):
        pendente = self.pendentes.pop(state or "", None)
        if not pendente:
            raise ErroGoogle("pedido de autorizacao desconhecido ou expirado; tenta outra vez")
        verificador, redirect_uri, _ = pendente
        cid, segredo = self.cliente()
        resp = _pedido(TOKEN_URL, {
            "code": codigo,
            "client_id": cid,
            "client_secret": segredo,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": verificador,
        })
        if not resp.get("refresh_token"):
            raise ErroGoogle("a Google nao devolveu refresh_token; remove o acesso em myaccount.google.com/permissions e liga outra vez")
        token = {
            "refresh_token": resp["refresh_token"],
            "access_token": resp.get("access_token"),
            "expira": time.time() + int(resp.get("expires_in", 0)) - 60,
            "scopes": resp.get("scope", ""),
        }
        perfil = _pedido(GMAIL + "/profile", token=token["access_token"])
        token["conta"] = perfil.get("emailAddress")
        self._guardar_token(token)
        return token["conta"]

    def _acesso(self):
        t = self.token()
        if not t or not t.get("refresh_token"):
            raise ErroGoogle("conta Google nao ligada")
        if t.get("access_token") and t.get("expira", 0) > time.time():
            return t["access_token"]
        cid, segredo = self.cliente() or (None, None)
        if not cid:
            raise ErroGoogle("cliente OAuth nao configurado")
        resp = _pedido(TOKEN_URL, {
            "client_id": cid,
            "client_secret": segredo,
            "refresh_token": t["refresh_token"],
            "grant_type": "refresh_token",
        })
        t["access_token"] = resp["access_token"]
        t["expira"] = time.time() + int(resp.get("expires_in", 0)) - 60
        self._guardar_token(t)
        return t["access_token"]

    def desligar(self):
        t = self.token()
        if t and t.get("refresh_token"):
            try:
                _pedido(REVOKE_URL, {"token": t["refresh_token"]})
            except ErroGoogle:
                pass  # o token pode ja ter sido revogado do lado da Google
        try:
            os.remove(self.ficheiro_token)
        except FileNotFoundError:
            pass

    # ---------- Leitura ----------
    def emails(self, desde_epoch=None):
        """Mensagens recentes, so cabecalhos e o excerto que o Gmail ja calcula."""
        acesso = self._acesso()
        if desde_epoch:
            janela = "after:%d" % int(desde_epoch - 86400)
        else:
            janela = "newer_than:%dd" % PRIMEIRA_JANELA_DIAS
        ids, pagina = [], None
        while len(ids) < MAX_MENSAGENS:
            params = {"q": CONSULTA + " " + janela, "maxResults": 100}
            if pagina:
                params["pageToken"] = pagina
            resp = _pedido(GMAIL + "/messages?" + urllib.parse.urlencode(params), token=acesso)
            ids += [m["id"] for m in resp.get("messages", [])]
            pagina = resp.get("nextPageToken")
            if not pagina:
                break
        mensagens = []
        for mid in ids[:MAX_MENSAGENS]:
            q = urllib.parse.urlencode([("format", "metadata"), ("metadataHeaders", "From"), ("metadataHeaders", "Subject")])
            m = _pedido(GMAIL + "/messages/" + mid + "?" + q, token=acesso)
            cab = {h["name"].lower(): h["value"] for h in m.get("payload", {}).get("headers", [])}
            mensagens.append({
                "id": m["id"],
                "fio": m.get("threadId"),
                "data": datetime.datetime.fromtimestamp(int(m.get("internalDate", 0)) / 1000, datetime.timezone.utc).isoformat(timespec="minutes"),
                "de": cab.get("from", ""),
                "assunto": cab.get("subject", ""),
                "resumo": m.get("snippet", ""),
            })
        return mensagens

    def eventos(self, dias=21):
        acesso = self._acesso()
        agora = datetime.datetime.now(datetime.timezone.utc)
        params = {
            "timeMin": agora.replace(hour=0, minute=0, second=0, microsecond=0).isoformat(),
            "timeMax": (agora + datetime.timedelta(days=dias)).isoformat(),
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": 100,
        }
        resp = _pedido(CALENDAR + "?" + urllib.parse.urlencode(params), token=acesso)
        saida = []
        for e in resp.get("items", []):
            if e.get("status") == "cancelled":
                continue
            ini, fim = e.get("start", {}), e.get("end", {})
            dia_todo = "date" in ini
            inicio = ini.get("date") or ini.get("dateTime", "")
            termino = fim.get("date") or fim.get("dateTime", "")
            if dia_todo and termino:
                # A Google da o fim de um evento de dia inteiro como o dia seguinte, exclusivo.
                termino = (datetime.date.fromisoformat(termino) - datetime.timedelta(days=1)).isoformat()
            saida.append({
                "id": e.get("id"),
                "titulo": e.get("summary") or "(sem titulo)",
                "data": inicio[:10],
                "fim": termino[:10] if termino[:10] != inicio[:10] else None,
                "hora": None if dia_todo else inicio[11:16],
                "local": e.get("location"),
                "link": e.get("htmlLink"),
            })
        return saida
