#!/usr/bin/env python3
"""Painel do dia: serve a interface e uma pequena API sobre o tracker de candidaturas.

Uso:  python3 painel/servidor.py [--porta 8787] [--host 127.0.0.1] [--abrir]

So usa a biblioteca padrao do Python. Ver o README para correr em Docker.

Variaveis de ambiente:
  PAINEL_DADOS     pasta de dados (omissao: ./dados). Se nao tiver tracker.json
                   e dia.json, sao copiados os de exemplo.
  PAINEL_TRACKER   caminho do tracker.json (omissao: <dados>/tracker.json)
  PAINEL_DIA       caminho do dia.json     (omissao: <dados>/dia.json)
  PAINEL_HOST      endereco onde escutar   (omissao: 127.0.0.1; no contentor 0.0.0.0)
  PAINEL_PORTA     porta                   (omissao: 8787)
  PAINEL_SYNC_MIN  minutos entre leituras do Gmail e do Calendar (omissao: 30; 0 desliga)
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   cliente OAuth (ou <dados>/google_client.json)

API (JSON, so pedidos locais):
  GET  /api/estado            tracker, dia.json, caixa de email, calendario e estado da ligacao
  POST /api/candidatura       {"id", "estado", "contacto"?}  muda o estado no tracker
  POST /api/tarefa            {"id", "feito"}                marca uma tarefa
  POST /api/leitura           {"capitulo"}                   progresso do livro
  POST /api/email             {"id", "visto"?, "candidatura"?}
  POST /api/google/sincronizar
  POST /api/google/desligar
  GET  /oauth/inicio           comeca a ligacao a conta Google (a Google volta a / com ?code&state)
"""
import argparse
import datetime
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from classificar import classificar, sugestao  # noqa: E402
from conta_google import ErroGoogle, Google  # noqa: E402

AQUI = os.path.dirname(os.path.abspath(__file__))
ESTATICO = os.path.join(AQUI, "static")
EXEMPLO = os.path.join(os.path.dirname(AQUI), "exemplo")

DADOS = os.path.abspath(os.environ.get("PAINEL_DADOS") or os.path.join(os.path.dirname(AQUI), "dados"))
TRACKER = os.path.abspath(os.environ.get("PAINEL_TRACKER") or os.path.join(DADOS, "tracker.json"))
DIA = os.path.abspath(os.environ.get("PAINEL_DIA") or os.path.join(DADOS, "dia.json"))
CAIXA = os.path.join(DADOS, "caixa.json")
SYNC_MIN = float(os.environ.get("PAINEL_SYNC_MIN") or 30)
ESTADOS = ("triagem", "rascunho", "enviada", "entrevista", "fechada")
MAX_EMAILS = 400

# Um so escritor de cada vez: o servidor e multi-thread e a sincronizacao corre a parte.
trinco = threading.Lock()
trinco_sync = threading.Lock()
google = Google(DADOS)
estado_sync = {"a_correr": False, "erro": None}


def ler(caminho, omissao=None):
    try:
        with open(caminho, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        if omissao is not None:
            return omissao
        raise


def escrever(caminho, dados):
    # Escrita atomica: um leitor nunca ve o ficheiro a meio.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(caminho), prefix=".painel-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(dados, indent=2, ensure_ascii=False) + "\n")
    # mkstemp cria com 600; o ficheiro novo fica com as permissoes do antigo.
    modo = os.stat(caminho).st_mode & 0o777 if os.path.exists(caminho) else 0o644
    os.chmod(tmp, modo)
    os.replace(tmp, caminho)


def hoje():
    return datetime.date.today().isoformat()


def preparar_dados():
    os.makedirs(DADOS, exist_ok=True)
    for destino, nome in ((TRACKER, "tracker.json"), (DIA, "dia.json")):
        if not os.path.exists(destino):
            os.makedirs(os.path.dirname(destino), exist_ok=True)
            shutil.copyfile(os.path.join(EXEMPLO, nome), destino)
            print("Criado %s a partir do exemplo" % destino, flush=True)


# ---------- Sincronizacao com a Google ----------
def sincronizar():
    if not trinco_sync.acquire(blocking=False):
        return
    estado_sync["a_correr"] = True
    try:
        caixa = ler(CAIXA, {"emails": [], "calendario": []})
        candidaturas = ler(TRACKER).get("candidaturas", [])
        conhecidos = {e["id"] for e in caixa.get("emails", [])}
        novos = []
        for m in google.emails(caixa.get("ultima_sync")):
            if m["id"] in conhecidos:
                continue
            m.update(classificar(m, candidaturas))
            m["visto"] = m["tipo"] in ("alerta", "outro")
            novos.append(m)
        calendario = google.eventos()
        with trinco:
            caixa = ler(CAIXA, {"emails": [], "calendario": []})
            emails = novos + [e for e in caixa.get("emails", []) if e["id"] not in {n["id"] for n in novos}]
            emails.sort(key=lambda e: e.get("data", ""), reverse=True)
            caixa.update({"emails": emails[:MAX_EMAILS], "calendario": calendario, "ultima_sync": time.time()})
            escrever(CAIXA, caixa)
        estado_sync["erro"] = None
        print("Google: %d emails novos, %d eventos" % (len(novos), len(calendario)), flush=True)
    except ErroGoogle as e:
        estado_sync["erro"] = str(e)
        print("Google: %s" % e, flush=True)
    finally:
        estado_sync["a_correr"] = False
        trinco_sync.release()


def sincronizar_em_fundo():
    threading.Thread(target=sincronizar, daemon=True).start()


def ciclo_sync():
    while True:
        if google.estado()["ligado"]:
            sincronizar()
        time.sleep(max(SYNC_MIN, 1) * 60)


def vista_caixa(candidaturas):
    """Caixa para o browser: a sugestao calcula-se com o tracker de agora."""
    caixa = ler(CAIXA, {"emails": [], "calendario": []})
    por_id = {c.get("id"): c for c in candidaturas}
    emails = []
    for e in caixa.get("emails", []):
        e = dict(e)
        e["sugestao"] = None if e.get("visto") else sugestao(e.get("tipo"), por_id.get(e.get("candidatura")))
        emails.append(e)
    g = google.estado()
    g.update({"ultima_sync": caixa.get("ultima_sync"), "a_correr": estado_sync["a_correr"], "erro": estado_sync["erro"]})
    return {"emails": emails, "calendario": caixa.get("calendario", []), "google": g}


class Painel(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ESTATICO, **kwargs)

    def log_message(self, fmt, *args):
        if self.command == "POST":
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def json(self, codigo, corpo):
        dados = json.dumps(corpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)

    def redirecionar(self, url):
        self.send_response(302)
        self.send_header("Location", url)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def local(self):
        # Recusa pedidos vindos de outras paginas abertas no browser (DNS rebinding e CSRF).
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        origem = self.headers.get("Origin")
        locais = ("127.0.0.1", "localhost", "::1")
        if host not in locais:
            return False
        if origem and urllib.parse.urlsplit(origem).hostname not in locais:
            return False
        return True

    def do_GET(self):
        if not self.local():
            return self.json(403, {"erro": "so pedidos locais"})
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/api/estado":
            try:
                tracker = ler(TRACKER)
                dia = ler(DIA)
                cands = tracker.get("candidaturas", [])
                return self.json(200, {"hoje": hoje(), "candidaturas": cands, "dia": dia, **vista_caixa(cands)})
            except (OSError, ValueError) as erro:
                return self.json(500, {"erro": str(erro)})
        if url.path == "/oauth/inicio":
            try:
                # Clientes "Desktop app" aceitam loopback na raiz, em qualquer porta.
                retorno = "http://%s/" % self.headers.get("Host")
                return self.redirecionar(google.url_autorizacao(retorno))
            except ErroGoogle as e:
                return self.json(400, {"erro": str(e)})
        q = dict(urllib.parse.parse_qsl(url.query))
        if url.path == "/" and ("state" in q or "error" in q):
            if q.get("error"):
                estado_sync["erro"] = "a Google recusou a ligacao: %s" % q["error"]
                return self.redirecionar("/#caixa")
            try:
                google.concluir(q.get("state"), q.get("code"))
                estado_sync["erro"] = None
                sincronizar_em_fundo()
            except ErroGoogle as e:
                estado_sync["erro"] = str(e)
            return self.redirecionar("/#caixa")
        if url.path.endswith(".json"):
            return self.json(404, {"erro": "nao encontrado"})
        return super().do_GET()

    def do_POST(self):
        if not self.local():
            return self.json(403, {"erro": "so pedidos locais"})
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.json(415, {"erro": "esperava JSON"})
        try:
            tamanho = int(self.headers.get("Content-Length") or 0)
            corpo = json.loads(self.rfile.read(min(tamanho, 65536)) or b"{}")
        except ValueError:
            return self.json(400, {"erro": "JSON invalido"})

        rota = urllib.parse.urlsplit(self.path).path
        if rota == "/api/google/sincronizar":
            if not google.estado()["ligado"]:
                return self.json(400, {"erro": "conta Google nao ligada"})
            sincronizar_em_fundo()
            return self.json(202, {"a_correr": True})
        if rota == "/api/google/desligar":
            with trinco:
                google.desligar()
                if os.path.exists(CAIXA):
                    os.remove(CAIXA)
            estado_sync["erro"] = None
            return self.json(200, {"ligado": False})
        with trinco:
            if rota == "/api/candidatura":
                return self.candidatura(corpo)
            if rota == "/api/tarefa":
                return self.tarefa(corpo)
            if rota == "/api/leitura":
                return self.leitura(corpo)
            if rota == "/api/email":
                return self.email(corpo)
        return self.json(404, {"erro": "rota desconhecida"})

    def candidatura(self, corpo):
        estado = corpo.get("estado")
        if estado not in ESTADOS:
            return self.json(400, {"erro": "estado invalido"})
        contacto = corpo.get("contacto")
        if contacto is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(contacto)):
            return self.json(400, {"erro": "contacto deve ser AAAA-MM-DD"})
        dados = ler(TRACKER)
        for c in dados.get("candidaturas", []):
            if c.get("id") == corpo.get("id"):
                c["estado"] = estado
                if estado == "enviada" and not c.get("enviada"):
                    c["enviada"] = hoje()
                if contacto:
                    c["contacto"] = contacto
                escrever(TRACKER, dados)
                return self.json(200, c)
        return self.json(404, {"erro": "candidatura nao encontrada"})

    def tarefa(self, corpo):
        dados = ler(DIA)
        for t in dados.get("tarefas", []):
            if t.get("id") == corpo.get("id"):
                t["feito"] = hoje() if corpo.get("feito") else None
                escrever(DIA, dados)
                return self.json(200, t)
        return self.json(404, {"erro": "tarefa nao encontrada"})

    def leitura(self, corpo):
        dados = ler(DIA)
        livro = dados.get("leitura", {})
        try:
            capitulo = int(corpo.get("capitulo"))
        except (TypeError, ValueError):
            return self.json(400, {"erro": "capitulo invalido"})
        livro["capitulo"] = max(0, min(capitulo, int(livro.get("capitulos", 0))))
        livro["atualizado"] = hoje()
        dados["leitura"] = livro
        escrever(DIA, dados)
        return self.json(200, livro)

    def email(self, corpo):
        caixa = ler(CAIXA, {"emails": []})
        for e in caixa.get("emails", []):
            if e.get("id") == corpo.get("id"):
                if "visto" in corpo:
                    e["visto"] = bool(corpo["visto"])
                if "candidatura" in corpo:
                    ids = {c.get("id") for c in ler(TRACKER).get("candidaturas", [])}
                    if corpo["candidatura"] is not None and corpo["candidatura"] not in ids:
                        return self.json(400, {"erro": "candidatura desconhecida"})
                    e["candidatura"] = corpo["candidatura"]
                escrever(CAIXA, caixa)
                return self.json(200, e)
        return self.json(404, {"erro": "email nao encontrado"})


def main():
    p = argparse.ArgumentParser(description="Painel do dia")
    p.add_argument("--porta", type=int, default=int(os.environ.get("PAINEL_PORTA") or 8787))
    p.add_argument("--host", default=os.environ.get("PAINEL_HOST") or "127.0.0.1")
    p.add_argument("--abrir", action="store_true", help="abre o painel no browser")
    args = p.parse_args()

    preparar_dados()
    if SYNC_MIN > 0:
        threading.Thread(target=ciclo_sync, daemon=True).start()

    servidor = ThreadingHTTPServer((args.host, args.porta), Painel)
    url = "http://localhost:%d/" % args.porta
    print("Painel em %s  (Ctrl+C para fechar)" % url, flush=True)
    if not google.estado()["configurado"]:
        print("Google: sem cliente OAuth; ver docs/google.md para ligar o Gmail e o Calendar", flush=True)
    if args.abrir:
        threading.Timer(0.4, webbrowser.open, (url,)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
