FROM python:3.12-slim

# So biblioteca padrao: nada para instalar alem da propria aplicacao.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PAINEL_HOST=0.0.0.0 \
    PAINEL_PORTA=8787 \
    PAINEL_DADOS=/dados

WORKDIR /app
COPY painel/ painel/
COPY exemplo/ exemplo/

# Utilizador sem privilegios; a pasta de dados e montada por cima de /dados.
RUN useradd --uid 1000 --create-home painel && mkdir -p /dados && chown painel:painel /dados
USER painel
VOLUME ["/dados"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/estado', timeout=4)"

CMD ["python", "painel/servidor.py"]
