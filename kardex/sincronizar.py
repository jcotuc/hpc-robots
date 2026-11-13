"""
Robot Kardex → inventario de la app de repuestos (Supabase ConsumosCS).

  1. Pausa los robots de ESTA PC (archivo hpc-robots/.pausa-kardex, ver shared/kardex-pausa.mjs)
  2. Extrae ExistenciaWMS de KardexWmsSap.exe (kardex_wms.py)
  3. Sube las filas CS/KB a rep_kardex_existencias (una "carga")
  4. rep_kardex_comparar cruza contra rep_existencias respetando apartados y,
     si kardex_modo = 'aplicar', corrige. Si no, solo deja las diferencias.
  5. Quita la pausa (siempre, aunque falle) y reporta al dungeon

Uso (PowerShell, en esta carpeta):
  py sincronizar.py                    corrida normal (lo que hace la tarea programada)
  py sincronizar.py --corroborar       compara aunque kardex_modo sea 'aplicar'
  py sincronizar.py --archivo X.xlsx   usa un Excel ya extraído (siempre solo corrobora, no pausa)
  py sincronizar.py --estado           muestra config y últimas corridas. No hace nada
"""
import argparse
import csv
import json
import logging
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
for _s in (sys.stdout, sys.stderr):  # emojis aunque la consola/log sea cp1252
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
LOGS = RAIZ / "logs"
SALIDAS = RAIZ / "salidas"
LOGS.mkdir(exist_ok=True)
SALIDAS.mkdir(exist_ok=True)
HOY = datetime.now().strftime("%Y-%m-%d")
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S",
    handlers=[logging.FileHandler(LOGS / f"detalle-{HOY}.log", encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("kardex")
COLUMNAS = ["Ubicacion", "Codigo", "Descripcion", "Existencia", "Bodega"]
LOTE = 1000
PAUSA_PC = RAIZ.parent / ".pausa-kardex"   # pausa general: los robots de esta PC lo revisan al arrancar (shared/kardex-pausa.mjs)


def resumen(linea):
    try:
        with open(LOGS / f"resumen-{HOY}.log", "a", encoding="utf-8") as f:
            f.write(f"{datetime.now():%H:%M:%S}  {linea}\n")
    except Exception:
        pass


# ---------- .env ----------
def leer_env():
    ruta = RAIZ / ".env"
    if not ruta.exists():
        sys.exit("❌ Falta .env (copia .env.example como .env y llénalo)")
    for linea in ruta.read_text(encoding="utf-8-sig").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        k, v = linea.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        os.environ.setdefault(k.strip(), v)


# ---------- Supabase (REST, sin librerías extra) ----------
class Supa:
    def __init__(self, url, key):
        self.url = (url or "").rstrip("/")
        self.key = key or ""

    def _req(self, metodo, ruta, cuerpo=None, prefer=None, timeout=120):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if prefer:
            h["Prefer"] = prefer
        data = json.dumps(cuerpo, default=str).encode() if cuerpo is not None else None
        req = urllib.request.Request(f"{self.url}/rest/v1/{ruta}", data=data, method=metodo, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                txt = r.read().decode("utf-8")
                return json.loads(txt) if txt.strip() else None
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Supabase {metodo} {ruta.split('?')[0]}: HTTP {e.code} {e.read().decode('utf-8', 'ignore')[:300]}")

    def get(self, ruta):
        return self._req("GET", ruta)

    def post(self, ruta, cuerpo, prefer="return=minimal"):
        return self._req("POST", ruta, cuerpo, prefer)

    def patch(self, ruta, cuerpo):
        return self._req("PATCH", ruta, cuerpo, "return=minimal")

    def rpc(self, fn, args=None):
        return self._req("POST", f"rpc/{fn}", args or {}, timeout=300)


# ---------- Monitor (dungeon, Supabase kkzo) — mismo protocolo que shared/monitor.mjs ----------
class Monitor:
    def __init__(self, robot, intervalo_seg, activo=True):
        self.robot = robot
        self.intervalo = intervalo_seg
        self.pc = (os.environ.get("ROBOT_PC") or socket.gethostname()).strip().upper()
        self.centro = os.environ.get("ROBOT_CENTRO", "Nodus").strip()
        url = os.environ.get("MONITOR_SUPABASE_URL", "")
        key = os.environ.get("MONITOR_SUPABASE_KEY", "")
        self.token = os.environ.get("MONITOR_TOKEN", "").strip()
        self.on = bool(activo and url and key and os.environ.get("MONITOR_APAGADO") != "1")
        self.sb = Supa(url, key)
        self.avisado = False

    def _enviar(self, tipo, body):
        if not self.on:
            return
        try:
            if self.token:
                self.sb.post("rpc/robot_reportar", {"p_token": self.token, "p_tipo": tipo, "p_datos": body})
            elif tipo == "estado":
                self.sb.post("robot_status?on_conflict=robot,pc", body, "resolution=merge-duplicates,return=minimal")
            else:
                self.sb.post("robot_eventos", body)
        except Exception as e:  # el monitor nunca detiene al robot
            if not self.avisado:
                self.avisado = True
                log.info(f"   [monitor] no se pudo reportar: {e}")

    def estado(self, est, detalle=None, error=None):
        body = {"robot": self.robot, "pc": self.pc, "estado": est, "detalle": (detalle or "")[:500] or None,
                "llamada": None, "intervalo_seg": self.intervalo, "centro": self.centro}
        if error is not None:
            body["ultimo_error"] = str(error)[:500]
        self._enviar("estado", body)

    def evento(self, tipo, mensaje):
        self._enviar("evento", {"robot": self.robot, "pc": self.pc, "tipo": tipo, "llamada": None,
                                "mensaje": str(mensaje)[:500], "centro": self.centro})


# ---------- helpers ----------
def config(sb):
    return {r["clave"]: r["valor"] for r in sb.get("rep_config?select=clave,valor")}


def sku_txt(v):
    """Excel puede convertir 95781 en 95781.0: dejarlo como texto limpio."""
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    s = str(v).strip()
    return s[:-2] if s.endswith(".0") and s[:-2].isdigit() else s


def a_filas(df, prefijos):
    """DataFrame de Kardex → filas CS/KB agrupadas por bodega+ubicación+sku. Devuelve (filas, invalidas)."""
    if list(df.columns)[:5] != COLUMNAS:
        raise RuntimeError(f"Columnas inesperadas en ExistenciaWMS: {list(df.columns)} (esperaba {COLUMNAS})")
    agrup, invalidas = {}, 0
    for r in df.itertuples(index=False):
        ubic = str(r.Ubicacion or "").strip().upper()
        sku = sku_txt(r.Codigo).upper()
        bod = sku_txt(r.Bodega).upper()
        try:
            ex = float(r.Existencia)
        except (TypeError, ValueError):
            ex = float("nan")
        if not ubic or not sku or ex != ex:
            invalidas += 1
            continue
        if not any(ubic.startswith(p) for p in prefijos):
            continue
        k = (bod, ubic, sku)
        if k in agrup:
            agrup[k]["existencia"] += ex
        else:
            agrup[k] = {"sku": sku, "ubicacion": ubic, "bodega": bod or None,
                        "descripcion": (str(r.Descripcion).strip() if r.Descripcion is not None else None) or None,
                        "existencia": ex}
    return list(agrup.values()), invalidas


def exportar_diferencias(sb, carga_id):
    filas, pag = [], 1000   # la API devuelve máximo 1000 filas por llamada: paginar
    while True:
        lote = sb.get(f"rep_kardex_diferencias?carga_id=eq.{carga_id}&select=accion,sku,ubicacion,descripcion,app_existencia,"
                      f"app_cuarentena,wms_existencia,pendiente_descontar,objetivo,diferencia,motivo,aplicado"
                      f"&order=accion,sku,ubicacion&limit={pag}&offset={len(filas)}") or []
        filas += lote
        if len(lote) < pag:
            break
    if not filas:
        return None
    ruta = SALIDAS / f"diferencias_{carga_id}_{datetime.now():%Y%m%d_%H%M}.csv"
    with open(ruta, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)
    return ruta


def ver_estado(sb):
    cfg = config(sb)
    print("\n=== Config (rep_config) ===")
    for k in sorted(cfg):
        if k.startswith("kardex") or k == "robot_kardex_activo":
            print(f"  {k:22} {json.dumps(cfg[k], ensure_ascii=False)}")
    print(f"  en pausa ahora:        {sb.rpc('rep_kardex_en_pausa')}")
    print("\n=== Últimas corridas ===")
    for c in sb.get("rep_kardex_cargas?select=id,creada_en,pc,origen,filas,estado,motivo,resumen&order=id.desc&limit=8") or []:
        r = c.get("resumen") or {}
        print(f"  #{c['id']:<4} {c['creada_en'][:16]}  {c['estado']:10} {c['origen']:8} filas {c['filas']:<6} "
              f"act {r.get('actualizar', '-')} nuevo {r.get('nuevo', '-')} a0 {r.get('a_cero', '-')} revisar {r.get('revisar', '-')}"
              f"{'  · ' + c['motivo'] if c.get('motivo') else ''}")
    bod = sb.get("rep_existencias?select=bodega&limit=5000") or []
    print(f"\nBodegas en rep_existencias: {sorted({b['bodega'] for b in bod if b.get('bodega')}) or '(ninguna con bodega)'}")


# ---------- principal ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corroborar", action="store_true")
    ap.add_argument("--archivo")
    ap.add_argument("--estado", action="store_true")
    ap.add_argument("--diferencias", type=int, metavar="CARGA", help="solo exporta el CSV de diferencias de esa carga")
    args = ap.parse_args()

    leer_env()
    sb = Supa(os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    if not sb.url or not sb.key:
        sys.exit("❌ Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (ConsumosCS) en .env")
    if args.estado:
        return ver_estado(sb)
    if args.diferencias:
        print(exportar_diferencias(sb, args.diferencias) or "Sin diferencias")
        return

    desde_archivo = bool(args.archivo)
    mon = Monitor("kardex", intervalo_seg=int(os.environ.get("INTERVALO_SEG", "23400")), activo=not desde_archivo)
    cfg = config(sb)
    if cfg.get("robot_kardex_activo") is False:
        log.info("⏹️  robot_kardex_activo = false: no hago nada")
        resumen("--- corrida OMITIDA (robot apagado en rep_config)")
        mon.estado("esperando", "Apagado en la app (robot_kardex_activo)")
        return
    prefijos = [str(p).upper() for p in (cfg.get("kardex_prefijos") or ["CS", "KB"])]
    solo_corroborar = args.corroborar or desde_archivo
    pausado = False
    carga_id = None
    t0 = time.time()
    try:
        mon.estado("trabajando", "Leyendo Kardex WMS")
        if desde_archivo:
            import pandas as pd
            log.info(f"▶️  Desde archivo: {args.archivo} (solo corrobora)")
            df = pd.read_excel(args.archivo, dtype={"Codigo": str, "Bodega": str, "Ubicacion": str})
            consulta_en = datetime.fromtimestamp(Path(args.archivo).stat().st_mtime, timezone.utc)
        else:
            espera = int(os.environ.get("ESPERA_PAUSA_SEG", "120"))
            PAUSA_PC.write_text(f"Kardex actualizando inventario desde {datetime.now():%H:%M} ({mon.pc})", encoding="utf-8")
            pausado = True
            log.info(f"⏸️  Pausa activada (robots de esta PC). Espero {espera}s a que terminen su corrida")
            time.sleep(espera)
            from kardex_wms import extraer_existencia_wms
            # La carga se crea JUSTO antes de leer: su hora (reloj de Supabase) es el corte para los ajustes KB
            carga = sb.post("rep_kardex_cargas", {"pc": mon.pc, "origen": "kardex"}, "return=representation")
            carga_id = carga[0]["id"]
            log.info("▶️  Kardex: ExistenciaWMS → Actualizar (puede tardar varios minutos)")
            df = extraer_existencia_wms(opcion="con", salida=SALIDAS / f"existencia_wms_{datetime.now():%Y%m%d_%H%M}.xlsx")
        log.info(f"   Kardex devolvió {len(df)} filas en {time.time() - t0:.0f}s")

        filas, invalidas = a_filas(df, prefijos)
        log.info(f"   {len(filas)} filas {'/'.join(prefijos)} (todas las bodegas) · {invalidas} inválidas")
        if not filas:
            raise RuntimeError("Kardex no trajo ubicaciones CS/KB: no se toca nada")
        if invalidas > max(20, len(df) * 0.01):
            raise RuntimeError(f"{invalidas} filas sin SKU/ubicación/existencia válida: la copia salió mal, no se toca nada")

        if desde_archivo:
            carga = sb.post("rep_kardex_cargas", {"pc": mon.pc, "consulta_en": consulta_en.isoformat(), "origen": "archivo"},
                            "return=representation")
            carga_id = carga[0]["id"]
        for i in range(0, len(filas), LOTE):
            sb.post("rep_kardex_existencias", [dict(f, carga_id=carga_id) for f in filas[i:i + LOTE]])
        sb.patch(f"rep_kardex_cargas?id=eq.{carga_id}", {"estado": "lista", "filas": len(filas)})
        log.info(f"   Carga #{carga_id} subida ({len(filas)} filas). Cruzando con la app...")

        r = sb.rpc("rep_kardex_comparar", {"_carga_id": carga_id, "_solo_corroborar": solo_corroborar})
        csv_ruta = exportar_diferencias(sb, carga_id)
        if r.get("estado") == "rechazada":
            msg = f"Carga #{carga_id} RECHAZADA: trajo {r.get('filas_nodus')} filas de Nodus vs {r.get('filas_anterior')} la anterior. No se tocó el inventario"
            log.info(f"❌ {msg}")
            resumen(f"ERROR {msg}")
            mon.evento("error", msg)
            mon.estado("error", msg, msg)
            return 1
        verbo = "corregidas" if r.get("estado") == "aplicada" else "por corregir (modo corroborar)"
        txt = (f"#{carga_id} {r.get('estado')}: {r.get('filas_nodus')} filas Nodus · {r.get('iguales')} iguales · "
               f"{r.get('actualizar')} actualizar + {r.get('nuevo')} nuevas + {r.get('a_cero')} a cero {verbo} · "
               f"{r.get('revisar')} a revisar · {r.get('ajustes_kb')} ajustes KB")
        log.info(f"✅ {txt}")
        if csv_ruta:
            log.info(f"   Diferencias: {csv_ruta}")
        resumen(f"OK {txt}")
        mon.evento("ok", txt)
        if r.get("revisar"):
            mon.evento("info", f"REVISAR {r['revisar']} SKU/ubicación con diferencia que no se corrige sola (carga #{carga_id})")
        mon.estado("esperando", f"{r.get('revisar')} a revisar · {r.get('actualizar', 0) + r.get('nuevo', 0) + r.get('a_cero', 0)} diferencias")
        return 0
    except Exception as e:
        log.info(f"❌ {e}")
        resumen(f"--- corrida ERROR  {str(e).splitlines()[0][:300]}")
        if carga_id:
            try:
                sb.patch(f"rep_kardex_cargas?id=eq.{carga_id}", {"estado": "error", "motivo": str(e)[:500]})
            except Exception:
                pass
        mon.evento("error", e)
        mon.estado("error", str(e), e)
        return 1
    finally:
        if pausado:
            try:
                PAUSA_PC.unlink(missing_ok=True)
            except Exception as e:
                log.info(f"⚠️ No pude borrar {PAUSA_PC} ({e}); vence sola a los 45 min")
            log.info("▶️  Pausa quitada: los robots de esta PC siguen normal")
        log.info(f"   Fin en {time.time() - t0:.0f}s")


if __name__ == "__main__":
    sys.exit(main() or 0)
