"""Classifica emails de recrutamento e associa-os a candidaturas do tracker.

So regras, sem rede nem dependencias: e o que o painel usa depois de ler o
Gmail. O resultado e uma sugestao; quem muda o estado no tracker e a pessoa,
com um clique no painel.
"""
import re
import unicodedata

# Por ordem de prioridade: uma recusa costuma tambem agradecer a candidatura,
# por isso a recusa tem de ganhar a "rececao".
REGRAS = [
    ("recusa", [
        "infelizmente", "nao iremos dar seguimento", "nao vamos dar seguimento",
        "nao vamos avancar", "nao iremos avancar", "outro candidato", "outros candidatos",
        "nao foi selecionad", "nao foste selecionad", "nao temos vagas que se enquadrem",
        "decidimos nao", "lamentamos informar",
        "unfortunately", "not to move forward", "not be moving forward", "will not be moving",
        "decided to pursue other", "decided to move forward with other", "other candidates",
        "position has been filled", "regret to inform", "not been successful", "not successful on this occasion",
    ]),
    ("entrevista", [
        "entrevista", "agendar uma conversa", "agendar uma chamada", "marcar uma conversa",
        "interview", "schedule a call", "phone screen", "book a time", "invite you to a call",
    ]),
    ("teste", [
        "assessment", "questionario", "desafio tecnico", "teste tecnico", "teste online",
        "coding challenge", "technical test", "online test", "hackerrank", "codility",
        "testgorilla", "alva labs", "alvalabs",
    ]),
    ("rececao", [
        "candidatura recebida", "recebemos a tua candidatura", "recebemos a sua candidatura",
        "obrigado pela tua candidatura", "obrigado pela sua candidatura", "obrigada pela tua candidatura",
        "obrigada pela sua candidatura", "candidatura esta em analise", "candidatura submetida",
        "thank you for your application", "thank you for applying", "application received",
        "we have received your application", "we received your application", "application has been sent",
    ]),
]

# Remetentes e assuntos que sao alertas de vagas ou newsletters, nao respostas.
ALERTAS = [
    "jobalert", "job alert", "jobs2web", "match.indeed", "alertas de emprego", "novas ofertas",
    "novas oportunidades", "newsletter", "jobs you may be interested", "vagas recomendadas",
    "recommended jobs", "new jobs for you", "mais ofertas", "more jobs",
]

# O tipo de email sugere este estado no tracker.
ESTADO_SUGERIDO = {"recusa": "fechada", "entrevista": "entrevista", "rececao": "enviada"}
ORDEM_ESTADOS = ["triagem", "rascunho", "enviada", "entrevista", "fechada"]

SUFIXOS = {
    "ab", "lda", "sa", "inc", "ltd", "llc", "gmbh", "bv", "plc", "spa", "sl", "ag", "group", "grupo",
    "portugal", "pt", "consulting", "consultoria", "solutions", "technologies", "tecnologias",
    "the", "de", "da", "do", "e", "and", "&",
}
GENERICOS = {"empresa", "nao", "identificada", "identificar", "cliente", "por", "confirmar", "recrutador"}


def normalizar(texto):
    texto = unicodedata.normalize("NFD", str(texto or ""))
    texto = "".join(c for c in texto if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", texto.lower()).strip()


def tipo_de(remetente, assunto, resumo):
    alvo = normalizar(" ".join([remetente, assunto, resumo]))
    cabecalho = normalizar(" ".join([remetente, assunto]))
    if any(a in cabecalho for a in ALERTAS):
        return "alerta"
    for tipo, frases in REGRAS:
        if any(f in alvo for f in frases):
            return tipo
    return "outro"


def nucleo_empresa(empresa):
    """'Nordtel AB' -> ['nordtel']; 'ACME Software (Porto)' -> ['acme software', 'acme']."""
    base = re.sub(r"\(.*?\)", " ", normalizar(empresa))
    palavras = [p for p in re.split(r"[^a-z0-9]+", base) if p and p not in SUFIXOS and p not in GENERICOS]
    if not palavras:
        return []
    termos = [" ".join(palavras)]
    if len(palavras[0]) >= 4 and palavras[0] not in termos:
        termos.append(palavras[0])
    return [t for t in termos if len(t) >= 3]


def dominio(remetente):
    m = re.search(r"@([a-z0-9.-]+)", normalizar(remetente))
    return m.group(1) if m else ""


def associar(email, candidaturas):
    """Devolve o id da candidatura a que o email diz respeito, ou None.

    Procura primeiro os dominios explicitos de cada candidatura (campo
    opcional "dominios"), depois o nome da empresa no remetente e no assunto.
    Se varias candidaturas da mesma empresa baterem, prefere a mais recente
    que nao esteja fechada.
    """
    rem = normalizar(email.get("de"))
    dom = dominio(email.get("de"))
    texto = normalizar(" ".join([email.get("de", ""), email.get("assunto", ""), email.get("resumo", "")]))
    candidatos = []
    for c in candidaturas:
        doms = [normalizar(d) for d in c.get("dominios") or []]
        if dom and any(dom == d or dom.endswith("." + d) for d in doms):
            candidatos.append((3, c))
            continue
        termos = nucleo_empresa(c.get("empresa"))
        if any(re.search(r"\b" + re.escape(t) + r"\b", rem) or t.replace(" ", "") in dom for t in termos):
            candidatos.append((2, c))
        elif any(re.search(r"\b" + re.escape(t) + r"\b", texto) for t in termos):
            candidatos.append((1, c))
    if not candidatos:
        return None
    melhor = max(p for p, _ in candidatos)
    finalistas = [c for p, c in candidatos if p == melhor]
    finalistas.sort(key=lambda c: (c.get("estado") != "fechada", c.get("enviada") or ""), reverse=True)
    return finalistas[0].get("id")


def sugestao(tipo, candidatura):
    """Estado que o email sugere, so se fizer a candidatura avancar."""
    novo = ESTADO_SUGERIDO.get(tipo)
    if not novo or not candidatura:
        return None
    atual = candidatura.get("estado")
    if atual == novo or atual == "fechada":
        return None
    if novo == "enviada" and atual not in ("triagem", "rascunho"):
        return None
    return novo


def classificar(email, candidaturas):
    tipo = tipo_de(email.get("de"), email.get("assunto"), email.get("resumo"))
    cid = None if tipo == "alerta" else associar(email, candidaturas)
    cand = next((c for c in candidaturas if c.get("id") == cid), None)
    return {"tipo": tipo, "candidatura": cid, "sugestao": sugestao(tipo, cand)}
