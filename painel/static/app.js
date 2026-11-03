const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
document.documentElement.classList.add('js');

const $ = (id) => document.getElementById(id);
const DIA_MS = 86_400_000;
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const ESTADOS = [
  { id: 'triagem', nome: 'Triagem' },
  { id: 'rascunho', nome: 'Rascunho' },
  { id: 'enviada', nome: 'Enviada' },
  { id: 'entrevista', nome: 'Entrevista' },
  { id: 'fechada', nome: 'Fechada' },
];
const SEGUIMENTO_MIN = 10;
const SEGUIMENTO_MAX = 45;

let estado = null;
let ultimoTexto = '';
let arrastado = null;
let filtro = { texto: '', modo: 'todas', fechadas: false };
let primeiraVez = true;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Dados pessoais vêm do bloco "perfil" do dia.json; isto são os valores por omissão.
const perfil = () => ({ nome: '', titulo: 'Painel', cidade: '', prompt: 'eu@painel ~/candidaturas $', ...(estado?.dia?.perfil || {}) });
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

/* ---------- Datas ---------- */
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const inicioDoDia = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const deISO = (iso) => {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d);
};
const diasAte = (iso) => (iso ? Math.round((deISO(iso) - inicioDoDia()) / DIA_MS) : null);
const diasDesde = (iso) => (iso ? -diasAte(iso) : null);
const dataCurta = (iso) => {
  const d = deISO(iso);
  return `${d.getDate()} ${MESES[d.getMonth()]}`;
};
const minutos = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const agoraMin = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};

function etiquetaPrazo(dias) {
  if (dias === null) return { cls: 'none', txt: 'Sem prazo' };
  if (dias < 0) return { cls: 'late', txt: `Atrasado ${plural(-dias, 'dia', 'dias')}` };
  if (dias === 0) return { cls: 'today', txt: 'Hoje' };
  if (dias === 1) return { cls: 'soon', txt: 'Amanhã' };
  if (dias <= 3) return { cls: 'soon', txt: `${dias} dias` };
  return { cls: '', txt: `${dias} dias` };
}

function diasParado(c) {
  const v = [diasDesde(c.enviada), diasDesde(c.contacto)].filter((d) => d !== null);
  return v.length ? Math.min(...v) : null;
}

/* ---------- Rede ---------- */
async function api(rota, corpo) {
  const r = await fetch(rota, corpo === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || `HTTP ${r.status}`);
  return dados;
}

async function carregar(forcar = false) {
  try {
    const dados = await api('/api/estado');
    $('offline').hidden = true;
    const texto = JSON.stringify(dados);
    $('updated').textContent = `tracker.json · lido às ${new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}`;
    if (!forcar && texto === ultimoTexto) return;
    ultimoTexto = texto;
    estado = dados;
    render();
  } catch (e) {
    $('offline').hidden = false;
    $('updated').textContent = 'Sem ligação ao servidor';
  }
}

let toastTimer;
function toast(msg, erro = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', erro);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function acao(rota, corpo, msg) {
  try {
    await api(rota, corpo);
    if (msg) toast(msg);
  } catch (e) {
    toast(`Não gravou: ${e.message}`, true);
  }
  await carregar(true);
}


/* ---------- Rotina ---------- */
function rotinaDe(data) {
  const dow = data.getDay();
  const iso = isoLocal(data);
  const exc = (estado.dia.excecoes || []).filter((e) => e.data === iso);
  return (estado.dia.rotina || [])
    .filter((b) => b.dias.includes(dow))
    .map((b) => {
      const e = exc.find((x) => x.sem === b.titulo);
      return e ? { ...b, titulo: 'Outro compromisso', tipo: 'livre', nota: e.nota } : b;
    })
    .sort((a, b) => minutos(a.inicio) - minutos(b.inicio));
}

function proximoDiaUtil() {
  const d = inicioDoDia();
  do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}

/* ---------- Hero ---------- */
function renderHero(c) {
  const agora = new Date();
  const h = agora.getHours();
  $('greet').textContent = h < 12 ? 'Bom dia,' : h < 20 ? 'Boa tarde,' : 'Boa noite,';
  const p = perfil();
  $('dateLine').textContent = `${DIAS[agora.getDay()]}, ${agora.getDate()} de ${MESES[agora.getMonth()]}${p.cidade ? ` · ${p.cidade}` : ''}`;
  $('nome').textContent = p.nome ? `${p.nome}.` : '';
  $('brand').textContent = p.titulo;
  document.title = `${p.titulo} · Painel do Dia`;

  const u = urgentes();
  const prazos7 = u.filter((i) => i.dias !== null && i.dias <= 7).length;
  const rasc = c.filter((x) => x.estado === 'rascunho').length;
  const seg = seguimentos().ativos.length;
  $('lede').textContent = `${plural(prazos7, 'prazo', 'prazos')} nos próximos 7 dias, ${plural(rasc, 'candidatura', 'candidaturas')} em rascunho e ${plural(seg, 'seguimento', 'seguimentos')} por fazer.`;

  renderAgora();
  renderTerm(c, u, seg);
}

function renderAgora() {
  const blocos = rotinaDe(new Date());
  const m = agoraMin();
  const el = $('agora');
  if (!blocos.length) {
    const seg = rotinaDe(proximoDiaUtil());
    el.innerHTML = `<p class="eyebrow">Fim de semana</p><h3>Sem rotina marcada</h3><p>A rotina volta ${DIAS[proximoDiaUtil().getDay()]} às ${seg[0]?.inicio ?? '07:00'}.</p>`;
    return;
  }
  const atual = blocos.find((b) => m >= minutos(b.inicio) && m < minutos(b.fim));
  const prox = blocos.find((b) => minutos(b.inicio) > m);
  if (atual) {
    const p = (m - minutos(atual.inicio)) / (minutos(atual.fim) - minutos(atual.inicio));
    const falta = Math.ceil(minutos(atual.fim) - m);
    el.innerHTML = `
      <p class="eyebrow">Agora · ${atual.inicio} a ${atual.fim} · faltam ${falta} min</p>
      <h3>${esc(atual.titulo)}</h3>
      ${atual.nota ? `<p>${esc(atual.nota)}</p>` : ''}
      <div class="bar"><span style="transform: scaleX(${p.toFixed(3)})"></span></div>
      <p class="next">${prox ? `A seguir: ${esc(prox.titulo)} às ${prox.inicio}` : 'Último bloco do dia'}</p>`;
  } else if (prox) {
    el.innerHTML = `<p class="eyebrow">Antes do dia começar</p><h3>${esc(prox.titulo)}</h3><p>Às ${prox.inicio}.${prox.nota ? ` ${esc(prox.nota)}` : ''}</p>`;
  } else {
    const amanha = rotinaDe(proximoDiaUtil());
    const foco = amanha.find((b) => b.tipo === 'foco');
    el.innerHTML = `<p class="eyebrow">Dia de trabalho terminado</p><h3>Bom descanso.</h3><p>${DIAS[proximoDiaUtil().getDay()]} começa às ${amanha[0]?.inicio ?? '07:00'}${foco ? `; o primeiro foco é às ${foco.inicio}` : ''}.</p>`;
  }
}

function renderTerm(c, u, seg) {
  const conta = (e) => c.filter((x) => x.estado === e).length;
  const prox = u.find((i) => i.dias !== null && i.dias >= 0);
  const livro = estado.dia.leitura || {};
  const prompt = esc(perfil().prompt);
  const linhas = [
    `<span class="prompt">${prompt}</span> status --hoje`,
    `<span class="key">entrevista</span><span class="val ok">${conta('entrevista')}</span>`,
    `<span class="key">enviadas</span><span class="val">${conta('enviada')}</span>`,
    `<span class="key">rascunho</span><span class="val">${conta('rascunho')}</span>`,
    `<span class="key">triagem</span><span class="val">${conta('triagem')}</span>`,
    `<span class="key">seguimentos</span><span class="val${seg ? ' hot' : ''}">${seg}</span>`,
    `<span class="key">próximo_prazo</span><span class="val hot">${prox ? `${esc(prox.curto)} · ${prox.dias === 0 ? 'hoje' : `${prox.dias}d`}` : 'nenhum'}</span>`,
    livro.livro ? `<span class="key">leitura</span><span class="val">cap. ${livro.capitulo ?? 0}/${livro.capitulos ?? '?'}</span>` : null,
    `<span class="prompt">${prompt}</span> <span class="cursor">▍</span>`,
  ].filter(Boolean);
  const term = $('term');
  term.innerHTML = linhas.map((l, i) => `<div style="--i:${i}">${l}</div>`).join('');
  term.classList.toggle('typing', primeiraVez && !reduceMotion);
}

/* ---------- Urgente ---------- */
function urgentes() {
  const c = estado.candidaturas;
  const porId = Object.fromEntries(c.map((x) => [x.id, x]));
  const hoje = isoLocal(new Date());
  const ligadas = new Set();
  const itens = [];

  (estado.dia.tarefas || []).forEach((t) => {
    if (t.candidatura) ligadas.add(t.candidatura);
    if (t.feito && t.feito !== hoje) return;
    const cand = porId[t.candidatura];
    itens.push({
      tipo: 'tarefa',
      id: t.id,
      titulo: t.texto,
      detalhe: t.detalhe,
      curto: cand ? cand.empresa : t.texto,
      dias: diasAte(t.prazo),
      prazo: t.prazo,
      link: t.link,
      pasta: cand?.pasta,
      feito: Boolean(t.feito),
      destaque: t.destaque || null,
    });
  });

  c.forEach((x) => {
    if (!x.prazo || ligadas.has(x.id) || !['triagem', 'rascunho'].includes(x.estado)) return;
    const dias = diasAte(x.prazo);
    if (dias < -7) return;
    itens.push({
      tipo: 'candidatura',
      id: x.id,
      titulo: `${x.empresa}: ${x.funcao}`,
      detalhe: `Prazo da candidatura (${x.estado}).`,
      curto: x.empresa,
      dias,
      prazo: x.prazo,
      pasta: x.pasta,
      feito: false,
    });
  });

  return itens.sort((a, b) => {
    if (a.feito !== b.feito) return a.feito ? 1 : -1;
    // "Falta preencher": o que só depende dele sobe para o topo.
    if (Boolean(a.destaque) !== Boolean(b.destaque)) return a.destaque ? -1 : 1;
    if (a.dias === null && b.dias === null) return 0;
    if (a.dias === null) return 1;
    if (b.dias === null) return -1;
    return a.dias - b.dias;
  });
}

function seguimentos() {
  const ativos = [];
  let parados = 0;
  estado.candidaturas.forEach((c) => {
    if (!['enviada', 'entrevista'].includes(c.estado)) return;
    const d = diasParado(c);
    if (d === null) return;
    if (d > SEGUIMENTO_MAX) parados += 1;
    else if (d >= SEGUIMENTO_MIN) ativos.push({ ...c, parado: d });
  });
  ativos.sort((a, b) => b.parado - a.parado);
  return { ativos, parados };
}

function renderUrgente() {
  const itens = urgentes();
  const feitos = itens.filter((i) => i.feito).length;
  $('doneToday').textContent = feitos ? `${feitos} feita${feitos > 1 ? 's' : ''} hoje` : `${itens.length} em aberto`;

  $('urgList').innerHTML = itens.length ? itens.map((i) => {
    const e = etiquetaPrazo(i.dias);
    return `
      <li class="urg-item${i.feito ? ' done' : ''}${i.destaque && !i.feito ? ' destaque' : ''}">
        <div class="check-cell">${i.tipo === 'tarefa' ? `<input class="check" type="checkbox" data-tarefa="${esc(i.id)}" ${i.feito ? 'checked' : ''} aria-label="Marcar como feita">` : ''}</div>
        <div class="urg-body">
          ${i.destaque && !i.feito ? `<span class="due falta">${esc(i.destaque)}</span> ` : ''}<span class="due ${e.cls}">${e.txt}${i.prazo ? ` · ${dataCurta(i.prazo)}` : ''}</span>
          <h3>${esc(i.titulo)}</h3>
          ${i.detalhe ? `<p>${esc(i.detalhe)}</p>` : ''}
          ${i.link ? `<div class="urg-actions"><a class="linkbtn" href="${esc(i.link)}" target="_blank" rel="noopener">Abrir &rarr;</a></div>` : ''}
        </div>
      </li>`;
  }).join('') : '<li class="empty">Nada urgente. Bom sinal.</li>';

  const { ativos, parados } = seguimentos();
  $('segCount').textContent = ativos.length ? String(ativos.length) : '';
  $('segList').innerHTML = (ativos.length ? ativos.map((c) => `
      <li>
        <strong>${esc(c.empresa)}</strong>
        <span class="due age">${c.parado} dias</span>
        <span class="fn">${esc(c.funcao)}</span>
      </li>`).join('') : '<li class="empty">Nenhum seguimento pendente.</li>')
    + (parados ? `<li class="stale"><span class="fn">Mais ${plural(parados, 'candidatura parada', 'candidaturas paradas')} há mais de ${SEGUIMENTO_MAX} dias.</span></li>` : '');
}

/* ---------- Agenda ---------- */
function renderAgenda() {
  const hoje = new Date();
  let blocos = rotinaDe(hoje);
  const fimDeSemana = !blocos.length;
  if (fimDeSemana) {
    const d = proximoDiaUtil();
    blocos = rotinaDe(d);
    $('timelineTitle').textContent = `Fim de semana · plano de ${DIAS[d.getDay()]}`;
  } else {
    $('timelineTitle').textContent = 'Rotina de hoje';
  }

  const INICIO = 7 * 60;
  const tl = $('timeline');
  tl.classList.toggle('weekend', fimDeSemana);
  const ppm = parseFloat(getComputedStyle(tl).getPropertyValue('--ppm')) || 1.15;
  const m = agoraMin();
  let html = '';
  for (let h = 7; h <= 18; h += 1) html += `<span class="tl-hour" style="top:${(h * 60 - INICIO) * ppm}px">${String(h).padStart(2, '0')}:00</span>`;
  blocos.forEach((b) => {
    const ini = minutos(b.inicio);
    const fim = minutos(b.fim);
    const alto = (fim - ini) * ppm;
    const quando = fimDeSemana ? '' : m >= fim ? ' past' : m >= ini ? ' now' : '';
    html += `
      <div class="tl-block ${b.tipo}${quando}${alto >= 48 ? ' tall' : ''}" style="top:${(ini - INICIO) * ppm}px;height:${alto}px" title="${esc(b.titulo)}${b.nota ? ` · ${esc(b.nota)}` : ''}">
        <span class="t">${b.inicio}</span><span class="n">${esc(b.titulo)}</span>${alto >= 48 && b.nota ? `<span class="d">${esc(b.nota)}</span>` : ''}
      </div>`;
  });
  if (!fimDeSemana && m >= INICIO && m <= 18 * 60) html += `<div class="tl-now" style="top:${(m - INICIO) * ppm}px"></div>`;
  tl.innerHTML = html;

  renderLeitura();
  renderEventos();
}

function renderLeitura() {
  const l = estado.dia.leitura || {};
  $('leitura').hidden = !l.livro;
  if (!l.livro) return;
  const pct = l.capitulos ? (l.capitulo / l.capitulos) * 100 : 0;
  const hoje = rotinaDe(new Date()).filter((b) => b.tipo === 'leitura').map((b) => b.inicio);
  $('leitura').innerHTML = `
    <p class="badge">A ler</p>
    <h3>${esc(l.livro)}</h3>
    <p class="by">${esc(l.autor)}</p>
    <div class="meter"><span style="width:${pct}%"></span></div>
    <div class="row">
      <span>Capítulo ${l.capitulo ?? 0} de ${l.capitulos ?? '?'}${hoje.length ? ` · hoje ${hoje.join(' e ')}` : ''}</span>
      <span class="stepper">
        <button type="button" data-cap="-1" aria-label="Capítulo anterior">&minus;</button>
        <button type="button" data-cap="1" aria-label="Capítulo seguinte">+</button>
      </span>
    </div>`;
}

function renderEventos() {
  const google = (estado.calendario || []).map((e) => ({ ...e, titulo: e.hora ? `${e.hora} · ${e.titulo}` : e.titulo, google: true }));
  const evts = [...(estado.dia.eventos || []), ...google]
    .map((e) => ({ ...e, ate: diasAte(e.data), fimAte: diasAte(e.fim || e.data) }))
    .filter((e) => e.fimAte >= 0)
    .sort((a, b) => a.ate - b.ate)
    .slice(0, google.length ? 10 : 6);
  $('evtList').innerHTML = evts.length ? evts.map((e) => {
    const d = deISO(e.data);
    const aDecorrer = e.ate <= 0;
    const quando = aDecorrer ? 'A decorrer' : e.ate === 1 ? 'Amanhã' : `Daqui a ${e.ate} dias`;
    const intervalo = e.fim ? ` a ${dataCurta(e.fim)}` : '';
    return `
      <li>
        <div class="evt-date${aDecorrer ? ' live' : ''}"><b>${d.getDate()}</b><span>${MESES[d.getMonth()]}</span></div>
        <div>
          <h4>${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.titulo)}</a>` : esc(e.titulo)}</h4>
          <p>${quando}${intervalo ? ` · ${dataCurta(e.data)}${intervalo}` : ''}${e.local ? ` · ${esc(e.local)}` : ''}${e.google ? ' · <span class="src">Calendar</span>' : ''}</p>
        </div>
      </li>`;
  }).join('') : '<li class="empty">Sem eventos marcados.</li>';
}

/* ---------- Caixa ---------- */
const TIPOS = {
  recusa: { nome: 'Recusa', cls: 'late' },
  entrevista: { nome: 'Entrevista', cls: 'ok' },
  teste: { nome: 'Teste', cls: 'soon' },
  rececao: { nome: 'Receção', cls: '' },
  outro: { nome: 'Outro', cls: 'none' },
  alerta: { nome: 'Alerta', cls: 'none' },
};
let verTodosEmails = false;

const remetente = (de) => (String(de).match(/^\s*"?([^"<]+?)"?\s*</) || [, de])[1].trim();
const quandoEmail = (iso) => {
  const d = new Date(iso);
  const dias = Math.round((inicioDoDia() - inicioDoDia(d)) / DIA_MS);
  const hora = d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  return dias === 0 ? `hoje ${hora}` : dias === 1 ? `ontem ${hora}` : `${d.getDate()} ${MESES[d.getMonth()]}`;
};

function renderCaixa() {
  const g = estado.google || {};
  const box = $('googleBox');
  if (!g.configurado) {
    box.innerHTML = `<p>Para o painel ler o Gmail e o Calendar, cria um cliente OAuth na Google Cloud e passa-o ao servidor
      (<code>GOOGLE_CLIENT_ID</code> e <code>GOOGLE_CLIENT_SECRET</code>, ou <code>google_client.json</code> na pasta de dados).
      Os passos estão em <a href="https://github.com/Joseane772/job-search-dashboard/blob/main/docs/google.md" target="_blank" rel="noopener">docs/google.md</a>.</p>`;
  } else if (!g.ligado) {
    box.innerHTML = `<p>Liga a tua conta para o painel ler os emails de recrutamento e o calendário. Só leitura: o painel nunca envia nem apaga nada.</p>
      <a class="btn solid" href="/oauth/inicio">Ligar conta Google</a>`;
  } else {
    const quando = g.ultima_sync ? new Date(g.ultima_sync * 1000).toLocaleString('pt-PT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'nunca';
    box.innerHTML = `<p><strong>${esc(g.conta || 'Conta ligada')}</strong> · lida ${g.a_correr ? 'agora mesmo…' : quando}</p>
      <div class="g-actions">
        <button class="btn solid" type="button" data-google="sincronizar" ${g.a_correr ? 'disabled' : ''}>Ler agora</button>
        <button class="btn line" type="button" data-google="desligar">Desligar</button>
      </div>`;
  }
  if (g.erro) box.innerHTML += `<p class="g-erro">${esc(g.erro)}</p>`;

  const emails = (estado.emails || []).filter((e) => verTodosEmails || !e.visto);
  const nomes = Object.fromEntries((estado.candidaturas || []).map((c) => [c.id, c.empresa]));
  $('caixaCount').textContent = g.ligado ? `${(estado.emails || []).filter((e) => !e.visto).length} por rever` : '';
  $('caixaList').innerHTML = emails.length ? emails.slice(0, 60).map((e) => {
    const t = TIPOS[e.tipo] || TIPOS.outro;
    const sug = e.sugestao ? ESTADOS.find((x) => x.id === e.sugestao)?.nome : null;
    const gmail = `https://mail.google.com/mail/?authuser=${encodeURIComponent(g.conta || '')}#all/${encodeURIComponent(e.fio || e.id)}`;
    return `
      <li class="${e.visto ? 'seen' : ''}">
        <div class="mail-head">
          <span class="due ${t.cls}">${t.nome}</span>
          <strong>${esc(remetente(e.de))}</strong>
          <span class="mail-when">${quandoEmail(e.data)}</span>
        </div>
        <p class="mail-subj"><a href="${gmail}" target="_blank" rel="noopener">${esc(e.assunto || '(sem assunto)')}</a></p>
        <p class="mail-snip">${esc(e.resumo)}</p>
        <div class="mail-actions">
          <label class="mail-cand">Candidatura
            <select data-email-cand="${esc(e.id)}">
              <option value="">Nenhuma</option>
              ${(estado.candidaturas || []).filter((c) => c.estado !== 'fechada' || c.id === e.candidatura)
                .map((c) => `<option value="${esc(c.id)}" ${c.id === e.candidatura ? 'selected' : ''}>${esc(c.empresa)} · ${esc(c.funcao).slice(0, 40)}</option>`).join('')}
            </select>
          </label>
          ${sug ? `<button class="btn solid small" type="button" data-aplicar="${esc(e.id)}">Mudar ${esc(nomes[e.candidatura] || '')} para ${sug}</button>` : ''}
          <button class="btn line small" type="button" data-visto="${esc(e.id)}" data-valor="${e.visto ? '0' : '1'}">${e.visto ? 'Voltar a mostrar' : 'Arrumar'}</button>
        </div>
      </li>`;
  }).join('') : `<li class="empty">${g.ligado ? 'Nada por rever na caixa.' : 'Sem conta ligada.'}</li>`;
}

async function aplicarSugestao(id) {
  const e = (estado.emails || []).find((x) => x.id === id);
  if (!e || !e.sugestao || !e.candidatura) return;
  try {
    await api('/api/candidatura', { id: e.candidatura, estado: e.sugestao, contacto: isoLocal(new Date(e.data)) });
    await api('/api/email', { id, visto: true });
    toast(`${(estado.candidaturas.find((c) => c.id === e.candidatura) || {}).empresa}: ${e.sugestao}.`);
  } catch (err) {
    toast(`Não gravou: ${err.message}`, true);
  }
  await carregar(true);
}

/* ---------- Tracker ---------- */
const MODOS = [
  { id: 'todas', nome: 'Todas' },
  { id: 'prazo', nome: 'Com prazo' },
  { id: 'cidade', nome: 'Cidade' },
];

function montarFiltros() {
  const box = $('boardFilters');
  MODOS.forEach((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (m.id === filtro.modo ? ' active' : '');
    b.dataset.modo = m.id;
    b.textContent = m.nome;
    b.setAttribute('aria-pressed', m.id === filtro.modo);
    box.appendChild(b);
  });
  const f = document.createElement('button');
  f.type = 'button';
  f.className = 'chip';
  f.id = 'chipFechadas';
  f.textContent = 'Mostrar fechadas';
  f.setAttribute('aria-pressed', 'false');
  box.appendChild(f);

  box.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.id === 'chipFechadas') {
      filtro.fechadas = !filtro.fechadas;
      chip.classList.toggle('active', filtro.fechadas);
      chip.setAttribute('aria-pressed', filtro.fechadas);
    } else {
      filtro.modo = chip.dataset.modo;
      box.querySelectorAll('[data-modo]').forEach((c) => {
        const on = c.dataset.modo === filtro.modo;
        c.classList.toggle('active', on);
        c.setAttribute('aria-pressed', on);
      });
    }
    renderBoard();
  });
  $('search').addEventListener('input', (e) => {
    filtro.texto = e.target.value.trim().toLowerCase();
    renderBoard();
  });
}

const semAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function passaFiltro(c) {
  if (filtro.modo === 'prazo' && !c.prazo) return false;
  if (filtro.modo === 'cidade' && !semAcentos(c.local).includes(semAcentos(perfil().cidade))) return false;
  if (filtro.texto) {
    const alvo = semAcentos([c.empresa, c.funcao, c.local, c.nota].join(' '));
    if (!alvo.includes(semAcentos(filtro.texto))) return false;
  }
  return true;
}

function metaCartao(c) {
  if (c.prazo && ['triagem', 'rascunho'].includes(c.estado)) {
    const e = etiquetaPrazo(diasAte(c.prazo));
    return `<span class="due ${e.cls}">${e.txt}</span>`;
  }
  const d = diasParado(c);
  if (d !== null && c.estado !== 'fechada') return `<span class="due age">há ${plural(d, 'dia', 'dias')}</span>`;
  return '';
}

function renderBoard() {
  if (!estado) return;
  const colunas = ESTADOS.filter((e) => e.id !== 'fechada' || filtro.fechadas);
  const board = $('board');
  board.style.setProperty('--cols', colunas.length);
  board.innerHTML = colunas.map((col) => {
    const itens = estado.candidaturas.filter((c) => c.estado === col.id && passaFiltro(c));
    if (col.id !== 'fechada') {
      itens.sort((a, b) => (diasAte(a.prazo) ?? 999) - (diasAte(b.prazo) ?? 999) || (diasParado(a) ?? 999) - (diasParado(b) ?? 999));
    }
    return `
      <div class="column" data-estado="${col.id}">
        <div class="column-head"><span class="col-dot ${col.id}"></span><h3>${col.nome}</h3><span class="count">${itens.length}</span></div>
        <div class="column-body">
          ${itens.map((c, i) => `
            <article class="kcard tilt${c.estado === 'fechada' ? ' closed' : ''}" draggable="true" data-id="${esc(c.id)}" style="--i:${Math.min(i, 12)}">
              <p class="kcard-meta"><span class="loc">${esc(c.local || '')}</span>${metaCartao(c)}</p>
              <h4>${esc(c.empresa)}</h4>
              <p class="fn">${esc(c.funcao)}</p>
              ${c.nota ? `<p class="kcard-desc">${esc(c.nota)}</p>` : ''}
              ${c.estado === 'entrevista' ? '<div class="kcard-pulse" aria-hidden="true"><span></span></div>' : ''}
            </article>`).join('')}
        </div>
      </div>`;
  }).join('');
  bindTilt(board.querySelectorAll('.tilt'));
}

function ligarBoard() {
  const board = $('board');
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.kcard');
    if (!card) return;
    arrastado = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', arrastado);
  });
  board.addEventListener('dragend', (e) => {
    e.target.closest('.kcard')?.classList.remove('dragging');
    board.querySelectorAll('.drop-target').forEach((c) => c.classList.remove('drop-target'));
    arrastado = null;
  });
  board.addEventListener('dragover', (e) => {
    const col = e.target.closest('.column');
    if (!col || !arrastado) return;
    e.preventDefault();
    board.querySelectorAll('.drop-target').forEach((c) => c !== col && c.classList.remove('drop-target'));
    col.classList.add('drop-target');
  });
  board.addEventListener('drop', (e) => {
    const col = e.target.closest('.column');
    if (!col || !arrastado) return;
    e.preventDefault();
    const id = arrastado;
    const novo = col.dataset.estado;
    const c = estado.candidaturas.find((x) => x.id === id);
    arrastado = null;
    if (!c || c.estado === novo) return renderBoard();
    c.estado = novo;
    renderBoard();
    acao('/api/candidatura', { id, estado: novo }, `${c.empresa} → ${novo}`);
  });
  board.addEventListener('click', (e) => {
    e.target.closest('.kcard')?.classList.toggle('open');
  });
}

/* ---------- Tilt (como no portfólio) ---------- */
function bindTilt(nodes) {
  if (reduceMotion || !window.matchMedia('(hover: hover)').matches) return;
  nodes.forEach((el) => {
    if (el.dataset.tiltBound) return;
    el.dataset.tiltBound = '1';
    el.addEventListener('mousemove', (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty('--ry', `${x * 6}deg`);
      el.style.setProperty('--rx', `${-y * 6}deg`);
      el.style.setProperty('--mx', `${(x + 0.5) * 100}%`);
      el.style.setProperty('--my', `${(y + 0.5) * 100}%`);
    });
    el.addEventListener('mouseleave', () => {
      el.style.setProperty('--ry', '0deg');
      el.style.setProperty('--rx', '0deg');
    });
  });
}

/* ---------- Tudo ---------- */
function render() {
  if (arrastado) return;
  const chipCidade = document.querySelector('[data-modo="cidade"]');
  if (chipCidade) {
    chipCidade.textContent = perfil().cidade;
    chipCidade.hidden = !perfil().cidade;
  }
  renderHero(estado.candidaturas);
  renderUrgente();
  renderCaixa();
  renderAgenda();
  renderBoard();
  primeiraVez = false;
}

function tique() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  if (estado && d.getSeconds() === 0) {
    renderAgora();
    renderAgenda();
  }
}

function montarBurst() {
  const svg = $('burst');
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 60; i += 1) {
    const a = (i / 60) * Math.PI * 2;
    const r1 = 60 + (i % 6) * 4;
    const r2 = 150 + (i % 4) * 22;
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', (240 + Math.cos(a) * r1).toFixed(1));
    l.setAttribute('y1', (240 + Math.sin(a) * r1).toFixed(1));
    l.setAttribute('x2', (240 + Math.cos(a) * (r1 + r2)).toFixed(1));
    l.setAttribute('y2', (240 + Math.sin(a) * (r1 + r2)).toFixed(1));
    l.setAttribute('pathLength', '1');
    l.style.setProperty('--i', i);
    svg.appendChild(l);
  }
}

function montarScroll() {
  const progress = $('scrollProgress');
  const atualiza = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
  };
  window.addEventListener('scroll', atualiza, { passive: true });
  atualiza();

  const links = document.querySelectorAll('#navLinks a');
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${en.target.id}`));
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  document.querySelectorAll('section[id]').forEach((s) => spy.observe(s));

  const revelar = document.querySelectorAll('.section-title, .urg-grid > *, .agenda-grid > *, .board-lede, .board-filters');
  const obs = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      en.target.classList.add('in');
      obs.unobserve(en.target);
    });
  }, { threshold: 0.1 });
  revelar.forEach((el, i) => {
    el.classList.add('reveal');
    el.style.setProperty('--d', `${(i % 3) * 80}ms`);
    if (reduceMotion) el.classList.add('in');
    else obs.observe(el);
  });
}

document.addEventListener('change', (e) => {
  const sel = e.target.closest('[data-email-cand]');
  if (sel) {
    acao('/api/email', { id: sel.dataset.emailCand, candidatura: sel.value || null }, 'Associado.');
    return;
  }
  if (e.target.id === 'verTodos') {
    verTodosEmails = e.target.checked;
    renderCaixa();
    return;
  }
  const t = e.target.closest('[data-tarefa]');
  if (t) acao('/api/tarefa', { id: t.dataset.tarefa, feito: t.checked }, t.checked ? 'Feito.' : 'Reaberta.');
});

document.addEventListener('click', (e) => {
  const ap = e.target.closest('[data-aplicar]');
  if (ap) {
    aplicarSugestao(ap.dataset.aplicar);
    return;
  }
  const vi = e.target.closest('[data-visto]');
  if (vi) {
    acao('/api/email', { id: vi.dataset.visto, visto: vi.dataset.valor === '1' });
    return;
  }
  const gb = e.target.closest('[data-google]');
  if (gb) {
    const desligar = gb.dataset.google === 'desligar';
    if (desligar && !window.confirm('Desligar a conta Google e apagar os emails guardados no painel?')) return;
    acao(`/api/google/${gb.dataset.google}`, {}, desligar ? 'Conta desligada.' : 'A ler a caixa…');
    if (!desligar) setTimeout(() => carregar(true), 8000);
    return;
  }
  const cap = e.target.closest('[data-cap]');
  if (cap && estado) {
    const l = estado.dia.leitura || {};
    acao('/api/leitura', { capitulo: (l.capitulo || 0) + Number(cap.dataset.cap) });
  }
});

$('reload').addEventListener('click', () => carregar(true).then(() => toast('Atualizado.')));
window.addEventListener('focus', () => carregar());

montarBurst();
montarFiltros();
ligarBoard();
montarScroll();
bindTilt(document.querySelectorAll('.card.tilt'));
tique();
setInterval(tique, 1000);
setInterval(() => carregar(), 30_000);
carregar(true);
