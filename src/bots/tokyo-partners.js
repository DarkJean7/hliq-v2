// ============================================================================
//  TOKYO PARTNERS · bot de cartera horaria
//
//  Cada activo tiene dos ventanas horarias fijas, una LARGA y otra CORTA,
//  halladas barriendo todas las combinaciones de entrada y salida sobre ~200
//  dias de velas de 1h y quedandose con la de mayor PnL neto de comisiones.
//
//  UNA SOLA INSTALACION PARA TODA LA CARTERA. En la tarjeta del bot, en
//  "Mercados que este bot puede operar", añade los que quieras de la lista de
//  abajo -- uno, cinco o los quince. El bot opera cada tick TODOS los mercados
//  de su tarjeta que esten en la tabla, y no toca ningun otro: la lista de la
//  tarjeta es el limite, no una sugerencia.
//
//  Los 15 mercados de la cartera, con su nombre exacto en el exchange:
//
//    ZEC       ZEC           largo 07:00→21:00   corto 21:00→07:00
//    CASHCAT   CASHCAT       largo 02:00→19:00   corto 19:00→07:00
//    SMSN      xyz:SMSN      largo 23:00→18:00   corto 18:00→23:00
//    SKHX      xyz:SKHX      largo 04:00→17:00   corto 17:00→23:00
//    LIT       LIT           largo 00:00→18:00   corto 19:00→00:00
//    XMR       XMR           largo 16:00→06:00   corto 06:00→16:00
//    SNDK      xyz:SNDK      largo 23:00→21:00   corto 21:00→23:00
//    EWY       xyz:EWY       largo 23:00→19:00   corto 19:00→23:00
//    MU        xyz:MU        largo 23:00→21:00   corto 21:00→23:00
//    NEAR      NEAR          largo 20:00→17:00   corto 17:00→20:00
//    DRAM      xyz:DRAM      largo 23:00→19:00   corto 19:00→23:00
//    PUMP      PUMP          largo 20:00→18:00   corto 18:00→20:00
//    INTC      xyz:INTC      largo 09:00→05:00   corto 05:00→09:00
//    SPCX      xyz:SPCX      largo 23:00→03:00   corto 03:00→23:00
//    SOXL      xyz:SOXL      largo 14:00→03:00   corto 03:00→15:00
//
//  INTERVALO RECOMENDADO: 30-60 s. Al cambiar de ventana hacen falta dos ticks
//  (uno cierra, el siguiente abre), asi que el intervalo es lo que se tarda en
//  dar la vuelta a una posicion.
//
//  Todas las horas son de NUEVA YORK (America/New_York). El horario de verano
//  se resuelve solo: las ventanas se hallaron en esa zona y desplazarlas media
//  temporada las descuadraria.
//
// ─── AJUSTES ────────────────────────────────────────────────────────────────
//  No hace falta editar este archivo para cambiar nada de lo de abajo. Se
//  escribe en el campo "Ajustes" de la tarjeta, una linea por ajuste, y llega
//  como ctx.config.params. Lo que no pongas usa el valor por defecto.
//
//    riesgo         = 0.03      margen por operacion, fraccion del equity
//    apalancamiento = <tarjeta> multiplica la exposicion sobre ese margen.
//                               Por defecto toma el "Leverage" de la tarjeta.
//    usarPesos      = false     true escala el tamano por el peso del activo.
//                               Recomendado con varios mercados: reparte segun
//                               la tabla en vez de dar lo mismo a cada uno.
//    repartir       = true      con N mercados, divide el riesgo entre N para
//                               que la cartera entera arriesgue lo mismo que
//                               arriesgaria un solo mercado. Ponlo a false
//                               para que cada mercado use el riesgo completo.
//    minUsd         = 11        por debajo de ~10 USD el exchange rechaza
//    zona           = America/New_York
//    fijarApalancamiento = true false deja el apalancamiento de la cuenta
//    soloLargos     = false     true ignora las ventanas cortas
//    soloCortos     = false     true ignora las ventanas largas
//  ── TU PROPIA CARTERA: DOS LISTAS EN PARALELO ───────────────────────────
//  El mercado numero i usa el horario numero i. La barra separa las entradas.
//
//    activos  = ZEC | XMR | xyz:SPCX
//    horarios = 07:00-21:00, 21:00-07:00 | 16:00-06:00, 06:00-16:00 | 23:00-03:00, 03:00-23:00
//
//  Dentro de cada entrada van las cuatro horas de siempre: larga desde, larga
//  hasta, corta desde, corta hasta.
//
//  Escribir activos DEFINE la cartera: solo se operan esos, aunque la tabla de
//  arriba tenga quince. Si las dos listas no miden lo mismo no se opera NADA y se
//  dice por que -- emparejar hasta donde alcance es como el octavo mercado acaba
//  con el horario del septimo sin que nadie lo note.
//
//  ── SALIR POR PRECIO: TP Y SL ───────────────────────────────────────────
//    tp = 2        cierra cuando el precio se mueve un 2% A FAVOR
//    sl = 1.5      cierra cuando se mueve un 1.5% en contra
//    tp.ZEC = 3    lo mismo para un solo mercado
//    sl.XMR = 1
//
//  Son porcentaje de MOVIMIENTO DEL PRECIO, no de retorno sobre el margen: con
//  apalancamiento 3, un tp de 2 se cobra cuando el precio hace un 2% y el margen
//  ha hecho un 6%. Se dice asi porque el precio es lo que se puede mirar en el
//  grafico y comprobar. En 0 (por defecto) no hay tp ni sl y solo se sale por hora.
//
//  Tras salir por precio NO se vuelve a entrar hasta que cambie la ventana. Sin
//  eso el tick siguiente ve la ventana abierta y reabre el trade que el stop
//  acababa de cerrar, cada treinta segundos.
//
//  ── CUANTO SE ARRIESGA ──────────────────────────────────────────────────
//    margen = 50            USD de margen fijo por posicion. Manda sobre riesgo
//    margen.ZEC = 100       y sobre repartir, y NO se divide entre mercados:
//                           "50 por posicion" ya dice cuanto va en cada una.
//    apalancamiento.ZEC = 5 apalancamiento de un mercado concreto
//
//  Con margen = 50 y apalancamiento = 3 cada posicion son 150 USD de nocional.
//
//  ── VENTANAS DE CUALQUIER MERCADO ───────────────────────────────────────
//  No hace falta que un mercado este en la tabla de arriba. Se le dan sus horas
//  y ya opera, sean quince mercados o cuarenta.
//
//    ventana.HYPE     = 09:00-17:00, 17:00-09:00
//    ventana.SPCX     = 23:00-03:00, 03:00-23:00
//
//  Cuatro horas: larga desde, larga hasta, corta desde, corta hasta. La clave se
//  compara sin el prefijo del dex, asi que ventana.SPCX vale para xyz:SPCX. Esto
//  manda sobre la tabla, asi que tambien sirve para retocar una fila.
//
//    largo          = 07:00-21:00   ventana POR DEFECTO, solo para los mercados
//    corto          = 21:00-07:00   que no tienen fila ni ventana propia. Antes
//                                   pisaban todos; ya no, para poder añadir uno
//                                   sin retocar los quince.
//
//  Un mercado que acabe sin horas no se opera y se dice cual es. Inventarle unas
//  seria inventar la estrategia.
//
//  El "Max per order" de la tarjeta tambien manda: el tamano de cada orden se
//  recorta a ese tope. Si el tope queda por debajo de minUsd el bot no abre en
//  ese mercado y lo dice, en vez de mandar ordenes que el exchange rechaza.
// ============================================================================

// --- cartera -----------------------------------------------------------------
// ventana [entrada, salida]; si la salida es menor que la entrada, cruza la
// medianoche y la posicion se mantiene hasta el dia siguiente
const CARTERA = {
  "ZEC":      { mercado: "ZEC",          largo: ["07:00","21:00"], corto: ["21:00","07:00"], peso: 11.06 },
  "CASHCAT":  { mercado: "CASHCAT",      largo: ["02:00","19:00"], corto: ["19:00","07:00"], peso:  9.93 },
  "SMSN":     { mercado: "xyz:SMSN",     largo: ["23:00","18:00"], corto: ["18:00","23:00"], peso:  8.72 },
  "SKHX":     { mercado: "xyz:SKHX",     largo: ["04:00","17:00"], corto: ["17:00","23:00"], peso:  8.27 },
  "LIT":      { mercado: "LIT",          largo: ["00:00","18:00"], corto: ["19:00","00:00"], peso:  7.84 },
  "XMR":      { mercado: "XMR",          largo: ["16:00","06:00"], corto: ["06:00","16:00"], peso:  7.50 },
  "SNDK":     { mercado: "xyz:SNDK",     largo: ["23:00","21:00"], corto: ["21:00","23:00"], peso:  7.40 },
  "EWY":      { mercado: "xyz:EWY",      largo: ["23:00","19:00"], corto: ["19:00","23:00"], peso:  6.20 },
  "MU":       { mercado: "xyz:MU",       largo: ["23:00","21:00"], corto: ["21:00","23:00"], peso:  6.13 },
  "NEAR":     { mercado: "NEAR",         largo: ["20:00","17:00"], corto: ["17:00","20:00"], peso:  5.76 },
  "DRAM":     { mercado: "xyz:DRAM",     largo: ["23:00","19:00"], corto: ["19:00","23:00"], peso:  5.31 },
  "PUMP":     { mercado: "PUMP",         largo: ["20:00","18:00"], corto: ["18:00","20:00"], peso:  4.99 },
  "INTC":     { mercado: "xyz:INTC",     largo: ["09:00","05:00"], corto: ["05:00","09:00"], peso:  4.67 },
  "SPCX":     { mercado: "xyz:SPCX",     largo: ["23:00","03:00"], corto: ["03:00","23:00"], peso:  3.35 },
  "SOXL":     { mercado: "xyz:SOXL",     largo: ["14:00","03:00"], corto: ["03:00","15:00"], peso:  2.86 },
}

const CARTERA_N = Object.keys(CARTERA).length

// --- ajustes -----------------------------------------------------------------
// Los valores por defecto son los que tenia el archivo cuando todo estaba fijo
// en el codigo, asi que un bot sin ajustes se comporta exactamente igual que
// antes. Las lecturas son defensivas a proposito: un ajuste mal escrito debe
// caer en su valor por defecto, no dejar el tamano en NaN.
const POR_DEFECTO = {
  riesgo: 0.03,
  usarPesos: false,
  repartir: true,
  minUsd: 11,
  zona: "America/New_York",
  fijarApalancamiento: true,
  soloLargos: false,
  soloCortos: false,
}

function num(p, clave, def) {
  const v = Number(p[clave])
  return Number.isFinite(v) ? v : def
}

function bool(p, clave, def) {
  const v = p[clave]
  if (typeof v === "boolean") return v
  if (v === "true" || v === "false") return v === "true"
  return def
}

// "07:00-21:00" o "07:00 21:00" → ["07:00","21:00"]
function ventanaDe(v) {
  if (typeof v !== "string") return null
  const t = v.split(/[-,\s]+/).map(s => s.trim()).filter(Boolean)
  if (t.length !== 2) return null
  if (!t.every(x => /^\d{1,2}:\d{2}$/.test(x))) return null
  return t
}

// "07:00-21:00, 21:00-07:00" -> { largo:["07:00","21:00"], corto:["21:00","07:00"] }
// Cuatro horas: larga desde, larga hasta, corta desde, corta hasta. Los separadores
// dan igual, asi que se puede escribir con guiones, comas o espacios.
function ventanaPar(v) {
  if (typeof v !== "string") return null
  const t = v.split(/[-,\s]+/).map(s => s.trim()).filter(Boolean)
  if (t.length !== 4) return null
  if (!t.every(x => /^\d{1,2}:\d{2}$/.test(x))) return null
  return { largo: [t[0], t[1]], corto: [t[2], t[3]] }
}

// Las ventanas escritas mercado a mercado: "ventana.HYPE = 09:00-17:00, 17:00-09:00".
// La clave se compara sin el prefijo del dex, asi que ventana.SPCX vale para xyz:SPCX.
function ventanasPorMercado(p) {
  const out = {}
  for (const k of Object.keys(p || {})) {
    const m = /^ventana\.(.+)$/i.exec(k)
    if (!m) continue
    const par = ventanaPar(p[k])
    if (par) out[String(m[1]).split(":").pop().toUpperCase()] = par
  }
  return out
}

// Un numero escrito mercado a mercado: "apalancamiento.ZEC = 5", "tp.XMR = 2.5".
// Como en ventana.X, la clave se compara sin el prefijo del dex, asi que tp.SPCX
// vale para xyz:SPCX.
function numsPorMercado(p, prefijo) {
  const out = {}
  const re = new RegExp("^" + prefijo + "\.(.+)$", "i")
  for (const k of Object.keys(p || {})) {
    const m = re.exec(k)
    if (!m) continue
    const v = Number(p[k])
    if (Number.isFinite(v)) out[String(m[1]).split(":").pop().toUpperCase()] = v
  }
  return out
}

// El apalancamiento de un mercado. Se escribe "apalancamiento.ZEC = 5" para uno solo,
// "apalancamiento = 3" para todos, y si no se escribe nada sale de la tarjeta.
function apalDe(clave, a) {
  const v = paraMercado(a.apalPorMercado, clave, a.apalancamiento)
  return v > 0 ? v : a.apalancamiento
}

// El valor que le toca a un mercado: el suyo si lo tiene, y si no el general.
function paraMercado(mapa, clave, general) {
  const v = mapa[clave]
  return Number.isFinite(v) ? v : general
}

// Las dos listas en paralelo: el mercado numero i usa el horario numero i.
//
//   activos  = ZEC | XMR | xyz:SPCX
//   horarios = 07:00-21:00, 21:00-07:00 | 16:00-06:00, 06:00-16:00 | 23:00-03:00, 03:00-23:00
//
// La barra separa las entradas y dentro de cada una van las cuatro horas de
// siempre: larga desde, larga hasta, corta desde, corta hasta.
//
// Si las dos listas no miden lo mismo NO se empareja nada. Emparejar hasta donde
// alcance es como el mercado numero ocho acaba operando el horario del siete sin
// que nadie lo note; es mejor no operar y decir por que.
function paresPorLista(p) {
  const A = typeof p.activos === "string" ? p.activos.trim() : ""
  const H = typeof p.horarios === "string" ? p.horarios.trim() : ""
  if (!A && !H) return { pares: {}, error: null, tiene: false }
  if (!A || !H) {
    return { pares: {}, tiene: false, error: "falta " + (A ? "horarios" : "activos") +
      ": las dos listas van juntas, una entrada de horarios por cada activo" }
  }
  const act = A.split("|").map(x => x.trim()).filter(Boolean)
  const hor = H.split("|").map(x => x.trim()).filter(Boolean)
  if (act.length !== hor.length) {
    return { pares: {}, tiene: false, error: "activos tiene " + act.length + " y horarios tiene " +
      hor.length + "; los indices tienen que cuadrar, asi que no empareja ninguno" }
  }
  const out = {}
  for (let i = 0; i < act.length; i++) {
    const par = ventanaPar(hor[i])
    if (!par) {
      return { pares: {}, tiene: false, error: 'horarios #' + (i + 1) + ' ("' + hor[i] + '") para ' +
        act[i] + " no son cuatro horas HH:MM; ejemplo: 07:00-21:00, 21:00-07:00" }
    }
    out[String(act[i]).split(":").pop().toUpperCase()] = par
  }
  return { pares: out, error: null, tiene: true }
}

function ajustes(ctx) {
  const c = (ctx && ctx.config) || {}
  const p = c.params || {}
  return {
    riesgo:         num(p, "riesgo", POR_DEFECTO.riesgo),
    // El apalancamiento sale de la tarjeta salvo que se pida otro aqui: tener el
    // mismo numero en dos sitios es como acaban desincronizados.
    apalancamiento: num(p, "apalancamiento", Number(c.leverage) > 0 ? Number(c.leverage) : 3),
    usarPesos:      bool(p, "usarPesos", POR_DEFECTO.usarPesos),
    repartir:       bool(p, "repartir", POR_DEFECTO.repartir),
    minUsd:         num(p, "minUsd", POR_DEFECTO.minUsd),
    zona:           typeof p.zona === "string" && p.zona ? p.zona : POR_DEFECTO.zona,
    fijar:          bool(p, "fijarApalancamiento", POR_DEFECTO.fijarApalancamiento),
    soloLargos:     bool(p, "soloLargos", POR_DEFECTO.soloLargos),
    soloCortos:     bool(p, "soloCortos", POR_DEFECTO.soloCortos),
    largo:          ventanaDe(p.largo),
    corto:          ventanaDe(p.corto),
    porMercado:     ventanasPorMercado(p),
    lista:          paresPorLista(p),
    mercado:        typeof p.mercado === "string" && p.mercado ? p.mercado : null,

    // Salidas por precio. 0 en cualquiera de las dos las apaga, que es como estaba
    // antes: la ventana horaria era la unica manera de salir. Son porcentaje de
    // MOVIMIENTO DEL PRECIO desde la entrada, no de retorno sobre el margen -- con
    // apalancamiento 3, un tp de 2 se cobra cuando el precio se mueve un 2% y el
    // margen ha hecho un 6%. Se dice asi porque el precio es lo que se puede mirar
    // en el grafico y comprobar.
    tp:             Math.max(0, num(p, "tp", 0)),
    sl:             Math.max(0, num(p, "sl", 0)),
    tpPorMercado:   numsPorMercado(p, "tp"),
    slPorMercado:   numsPorMercado(p, "sl"),

    // Margen fijo por posicion, en USD. Manda sobre riesgo y sobre repartir: quien
    // escribe "margen = 50" esta diciendo cuanto quiere comprometer, y calcularlo
    // ademas a partir del equity seria contestarle. 0 lo deja apagado.
    margen:         Math.max(0, num(p, "margen", 0)),
    margenPorMercado: numsPorMercado(p, "margen"),
    apalPorMercado: numsPorMercado(p, "apalancamiento"),
    // 0 en la tarjeta significa "sin tope", que aqui es un tope infinito.
    tope:           Number(c.maxUsd) > 0 ? Number(c.maxUsd) : Infinity,
  }
}

// La fila de la cartera que le toca a un mercado, con las ventanas que se hayan
// sobreescrito en los ajustes ya aplicadas. Devuelve null si ese mercado no
// esta en la tabla y no se le han dado ventanas a mano.
function filaDe(coin, a) {
  const base = a.mercado || String(coin || "").split(":").pop()
  const clave = String(base).toUpperCase()
  const fila = CARTERA[clave]
  const pesoDe = () => fila ? fila.peso : 100 / CARTERA_N

  // 1. Lo que se haya escrito para ESTE mercado manda sobre todo. Es como se retoca
  //    una fila de la tabla o se da de alta un mercado que no esta en ella.
  const propio = a.porMercado[clave]
  if (propio) return { clave, largo: propio.largo, corto: propio.corto, peso: pesoDe(), fuente: "ajuste" }

  // 2. Las dos listas en paralelo. Van por debajo de ventana.X, que apunta a un solo
  //    mercado y por tanto es lo mas concreto que se puede escribir, y por encima de
  //    la tabla, porque quien escribe las listas esta redefiniendo la cartera entera.
  const enLista = a.lista.pares[clave]
  if (enLista) return { clave, largo: enLista.largo, corto: enLista.corto, peso: pesoDe(), fuente: "lista" }

  // Y si hay listas, DEFINEN la cartera: lo que no aparece en activos no se opera,
  // aunque este en la tabla de arriba. Escribir tres mercados y que operase quince
  // seria contestar a otra pregunta -- el que quiera añadir uno a la tabla tiene
  // ventana.X, que sigue funcionando porque se mira antes que esto.
  if (a.lista.tiene) return null

  // 3. Su fila de la cartera, si la tiene. Estas horas salen del barrido sobre ~200
  //    dias, que es lo que hace que la estrategia sea una estrategia.
  if (fila) return { clave, largo: fila.largo, corto: fila.corto, peso: fila.peso, fuente: "cartera" }

  // 4. Y si no, las ventanas por defecto. Antes largo/corto pisaban TODOS los mercados,
  //    asi que no se podia añadir uno sin retocar los quince; ahora solo se usan donde
  //    no hay nada mejor, que es justo el mercado nuevo.
  if (a.largo && a.corto) return { clave, largo: a.largo, corto: a.corto, peso: 100 / CARTERA_N, fuente: "defecto" }

  // Sin horas no hay nada que operar, y adivinarlas seria inventar la estrategia.
  return null
}

// RIESGO es el MARGEN comprometido y el apalancamiento multiplica la exposicion:
// con 1000 de equity, riesgo 0.03 y apalancamiento 3 son 30 de margen y 90 de
// nocional. Para que el riesgo sea el nocional, pon apalancamiento = 1.
//
// n es cuantos mercados se lo reparten. Sin repartir, quince mercados abiertos a
// la vez son quince veces la exposicion que tenia el archivo de un solo mercado,
// que es la manera silenciosa de acabar liquidado por haber añadido mercados.
function tamanoUsd(ctx, fila, a, n) {
  const apal = apalDe(fila.clave, a)
  // Margen fijo: el nocional es margen x apalancamiento y nada mas. No se reparte
  // entre mercados ni se escala por peso, porque "50 por posicion" ya es la
  // respuesta a cuanto va en cada una -- dividirlo entre quince seria ignorarla.
  const fijo = paraMercado(a.margenPorMercado, fila.clave, a.margen)
  if (fijo > 0) return fijo * apal

  const base = (ctx.equity * a.riesgo * apal) / Math.max(1, n)
  const esc  = a.usarPesos ? (fila.peso / 100) * CARTERA_N : 1
  // Sin suelo y sin tope: el que llama los aplica, porque necesita saber CUANTO
  // los aplico. Un suelo invisible es como se gasta el doble de lo que se pidio.
  return base * esc
}

// --- utilidades --------------------------------------------------------------
// minuto del dia en la zona elegida; el % 24 evita el "24" que algunos motores
// devuelven para la medianoche
function minutoEn(ms, zona) {
  let p
  try {
    p = new Intl.DateTimeFormat("en-US", {
      timeZone: zona, hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date(ms))
  } catch (e) {
    // Una zona mal escrita tira Intl. Mejor seguir en Nueva York, que es donde
    // se hallaron las ventanas, que dejar de operar por una errata.
    log("zona horaria invalida:", zona, "- uso America/New_York")
    p = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date(ms))
  }
  const h = Number(p.find(x => x.type === "hour").value) % 24
  const m = Number(p.find(x => x.type === "minute").value)
  return h * 60 + m
}

function aMinutos(hhmm) {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

// dentro de la ventana, contemplando que cruce la medianoche
function dentro(min, ventana) {
  const a = aMinutos(ventana[0]), b = aMinutos(ventana[1])
  return b > a ? (min >= a && min < b) : (min >= a || min < b)
}

// -1 corto, 0 plano, 1 largo
function ladoActual(pos) {
  if (!pos) return 0
  const s = Number(pos.szi)
  if (!s || Math.abs(s) < 1e-12) return 0
  return s > 0 ? 1 : -1
}

function hhmmDe(min) {
  return String(Math.floor(min / 60)).padStart(2, "0") + ":" +
         String(min % 60).padStart(2, "0")
}

// --- apalancamiento: se intenta fijar una sola vez por mercado ---------------
const apalancamientoHecho = new Set()

function fijarApalancamiento(mercados, a) {
  if (!a.fijar) return
  const pendientes = mercados.filter(c => !apalancamientoHecho.has(c))
  if (!pendientes.length) return
  for (const c of pendientes) apalancamientoHecho.add(c)   // no reintentar cada tick
  Promise.resolve()
    .then(() => api.info({ type: "meta" }))
    .then(meta => {
      const uni = (meta && meta.universe) || []
      // Una sola lectura de meta para todos los mercados: quince peticiones
      // identicas contra el mismo endpoint es como se agota el limite por IP.
      return Promise.all(pendientes.map(c => {
        const i = uni.findIndex(x => x.name === c)
        if (i < 0) { log("apalancamiento: no encuentro", c, "en meta; queda el de la cuenta"); return null }
        // El de ESTE mercado, que puede no ser el general: apalancamiento.ZEC = 5
        // no serviria de nada si aqui se fijara el mismo numero en los quince.
        const apal = apalDe(String(c).split(":").pop().toUpperCase(), a)
        return api.exchange("updateLeverage", { asset: i, isCross: true, leverage: apal })
          .then(() => log("apalancamiento x" + apal + " fijado en", c))
          .catch(e => log("no se pudo fijar el apalancamiento en", c + ":", String(e)))
      }))
    })
    .catch(e => log("no se pudo leer meta:", String(e), "- se opera con el apalancamiento de la cuenta"))
}

// El precio de un mercado: marks lo trae ya en numero para los mercados de la
// tarjeta; mids es de todo el exchange y viene en cadenas.
function precioDe(ctx, coin) {
  const m = ctx.marks && ctx.marks[coin]
  if (Number.isFinite(m) && m > 0) return m
  const v = Number(ctx.mids && ctx.mids[coin])
  return Number.isFinite(v) && v > 0 ? v : 0
}

// Cuanto se ha movido el precio A FAVOR de la posicion, en porcentaje. Devuelve
// null si falta la entrada o el precio: sin uno de los dos no se sabe, y 0 diria
// que no se ha movido, que es otra cosa.
function movimientoPct(ctx, coin, pos, lado) {
  const entrada = Number(pos && pos.entryPx)
  const marca = precioDe(ctx, coin)
  if (!(entrada > 0) || !(marca > 0)) return null
  const pct = ((marca - entrada) / entrada) * 100
  return lado > 0 ? pct : -pct
}

let avisoFuera = false   // el aviso de mercados fuera de la cartera se da una vez
let avisoLista = false   // el de las listas descuadradas, tambien una sola vez

// Mercados de los que se ha salido por tp o sl, con la ventana en la que se salio.
// Sin esto el tick siguiente ve la ventana todavia abierta y vuelve a entrar, que
// convierte un stop en una manera cara de pagar comisiones cada quince segundos.
const salido = new Map()

// --- ciclo -------------------------------------------------------------------
// No es async a proposito: no espera ninguna promesa, y devolver una Promise
// obligaria a la app a resolverla antes de leer las intenciones.
//
// Devuelve una LISTA de intenciones, una por mercado que necesite moverse. Los
// que ya estan como toca no aparecen, asi que un tick normal devuelve la lista
// vacia y solo en los cambios de ventana devuelve algo.
function onTick(ctx) {
  const a = ajustes(ctx)

  // Las listas descuadradas no emparejan nada, asi que decirlo es lo unico que
  // separa "no opero porque me lo pediste mal" de "no opero y no se sabe".
  if (a.lista.error) {
    if (!avisoLista) {
      avisoLista = true
      log("activos/horarios:", a.lista.error, "- NO se opera nada hasta arreglarlo")
    }
    // Y no se opera. Caer a la tabla seria operar quince mercados con unas horas que
    // no son las que se pidieron, mientras el aviso se pierde entre los demas.
    return
  }

  // Los mercados de la tarjeta que ademas estan en la tabla.
  const enTarjeta = (ctx.coins && ctx.coins.length ? ctx.coins : [ctx.coin])
  const mercados = enTarjeta.filter(c => !!filaDe(c, a))
  const fuera = enTarjeta.filter(c => !filaDe(c, a))

  // Antes se ignoraban en silencio, y eso confunde: una tarjeta con BTC y los quince
  // de la cartera dice "16 mercados" y opera quince. Ahora se dice cuales sobran, una
  // sola vez, para que el numero de la tarjeta y lo que hace el bot se puedan cuadrar.
  if (fuera.length && !avisoFuera) {
    avisoFuera = true
    log("sin ventanas, NO se operan:", fuera.join(", "),
        "· opero", mercados.length, "de", enTarjeta.length,
        "· dales horas con  ventana." + fuera[0] + " = 07:00-21:00, 21:00-07:00",
        " o pon largo/corto como ventana por defecto")
  }

  if (!mercados.length) {
    log("ninguno de los mercados de la tarjeta esta en la cartera; añade alguno de la lista de arriba")
    return
  }

  fijarApalancamiento(mercados, a)

  const min = minutoEn(ctx.tick, a.zona)
  const hhmm = hhmmDe(min)

  // El riesgo se reparte entre los mercados activos, asi que añadir mercados no
  // multiplica la exposicion total de la cuenta. Con repartir = false cada uno
  // usa el riesgo entero, que es lo que hacia el archivo de un solo mercado.
  const n = a.repartir ? mercados.length : 1

  // Cuanto se pidio de verdad frente a cuanto se acaba gastando: con muchos
  // mercados el reparto puede caer por debajo del minimo del exchange, y
  // entonces el suelo manda y la cartera arriesga mas de lo que se configuro.
  const suelo = []
  let pedido = 0, gastado = 0

  const posiciones = new Map()
  for (const p of (ctx.positions || [])) posiciones.set(p.coin, p)

  const intenciones = []

  for (const coin of mercados) {
    const fila = filaDe(coin, a)
    const enL = !a.soloCortos && dentro(min, fila.largo)
    const enS = !a.soloLargos && dentro(min, fila.corto)

    // Si las dos ventanas se pisan la exposicion neta seria cero, asi que es
    // mejor estar plano que sostener largo y corto a la vez pagando dos
    // comisiones y dos funding por una posicion que se cancela. Comprobado
    // sobre el historico: mismo resultado que el backtest, mismo turnover.
    const objetivo = (enL && enS) ? 0 : enL ? 1 : enS ? -1 : 0
    const actual = ladoActual(posiciones.get(coin))

    // La ventana en la que estamos, como una cadena. Es lo que hace caducar el
    // bloqueo de tp/sl: cuando la ventana cambia, la firma cambia con ella.
    const firma = objetivo + "@" +
      (objetivo > 0 ? fila.largo : objetivo < 0 ? fila.corto : ["", ""]).join("-")
    if (salido.has(coin) && salido.get(coin) !== firma) salido.delete(coin)

    // Salidas por precio. Van antes de comparar objetivo y posicion: mientras la
    // ventana sigue abierta los dos coinciden, y ahi es justamente donde hay que
    // mirar el precio. Apagadas (tp = sl = 0) esto no hace nada y el bot se
    // comporta como siempre: se sale por hora y por nada mas.
    const posActual = posiciones.get(coin)
    if (actual !== 0) {
      const tp = paraMercado(a.tpPorMercado, fila.clave, a.tp)
      const sl = paraMercado(a.slPorMercado, fila.clave, a.sl)
      if (tp > 0 || sl > 0) {
        const mov = movimientoPct(ctx, coin, posActual, actual)
        if (mov === null) {
          log(hhmm, "·", fila.clave, "sin precio o sin entrada: no puedo medir tp/sl este tick")
        } else if ((tp > 0 && mov >= tp) || (sl > 0 && mov <= -sl)) {
          log(hhmm, "·", fila.clave, mov >= 0 ? "TP" : "SL", mov.toFixed(2) + "%",
              "· cierro", actual > 0 ? "largo" : "corto",
              "· pnl", Number(posActual && posActual.unrealizedPnl).toFixed(2))
          intenciones.push({ type: "close", coin: coin })
          salido.set(coin, actual + "@" +
            (actual > 0 ? fila.largo : fila.corto).join("-"))
          continue
        }
      }
    }

    if (objetivo === actual) continue

    // cerrar antes de darse la vuelta: una posicion neta no admite los dos lados
    if (actual !== 0) {
      const p = posiciones.get(coin)
      log(hhmm, "·", fila.clave, "cierro", actual > 0 ? "largo" : "corto",
          "· pnl", Number(p && p.unrealizedPnl).toFixed(2))
      intenciones.push({ type: "close", coin: coin })
      continue
    }

    // Salimos por precio en ESTA misma ventana: no se vuelve a entrar hasta que la
    // ventana cambie. Lo contrario es reabrir el trade que el stop acababa de cerrar.
    if (salido.get(coin) === firma) continue

    if (!ctx.equity) {
      log(hhmm, "·", fila.clave, "sin equity para abrir")
      continue
    }

    const bruto = tamanoUsd(ctx, fila, a, n)
    const conTope = Math.min(a.tope, bruto)
    // El tope de la tarjeta puede dejar el tamano por debajo del minimo del
    // exchange. Decirlo vale mas que mandar ordenes que rebotan.
    if (a.tope < a.minUsd) {
      log(hhmm, "·", fila.clave, "no abro: 'Max per order' es", a.tope,
          "USD y el minimo del exchange es", a.minUsd)
      continue
    }
    // El suelo se detecta comparando las ENTRADAS, no el resultado redondeado: con
    // 21.428571 el redondeo da 21.43, que es mayor que el reparto, y el bot avisaba de un
    // suelo que nunca se aplico -- con los dos numeros del aviso identicos.
    const conSuelo = a.minUsd > conTope + 1e-9
    const usd = Number((conSuelo ? a.minUsd : conTope).toFixed(2))
    if (conSuelo) { suelo.push(fila.clave); pedido += conTope } else { pedido += usd }
    gastado += usd

    const ventana = objetivo > 0 ? fila.largo : fila.corto
    log(hhmm, "·", fila.clave, "abro", objetivo > 0 ? "LARGO" : "CORTO",
        ventana[0] + "-" + ventana[1], "·", usd, "USD nocional")
    intenciones.push({ type: "market", coin: coin, isBuy: objetivo > 0, usd: usd })
  }

  if (suelo.length) {
    log("AVISO: el reparto deja", suelo.length, "mercados por debajo del minimo de",
        a.minUsd, "USD, asi que se abren a ese minimo:", Math.round(gastado), "USD en total",
        "en vez de los", Math.round(pedido), "que pide riesgo", a.riesgo + "x" + a.apalancamiento + ".",
        "Sube el riesgo, quita mercados o baja minUsd si tu exchange lo permite.")
  }

  if (!intenciones.length) return
  log(hhmm, "· NY ·", intenciones.length, "de", mercados.length,
      "mercados se mueven · equity", Number(ctx.equity).toFixed(2),
      "· riesgo", a.riesgo, "x" + a.apalancamiento, a.repartir ? "repartido entre " + n : "por mercado")
  return intenciones
}
