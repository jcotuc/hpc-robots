"""
Paso del robot de auditoría: extraer "ExistenciaWMS" desde KardexWmsSap.exe
(WinForms .NET 2.0) y devolverla como DataFrame / Excel.

Flujo (igual al manual):
  1. Abrir la app (o conectarse si ya está abierta) y aceptar la advertencia si sale
  2. Pestaña ExistenciaWMS
  3. (Opcional) filtros + opción de existencia
  4. Actualizar y esperar (la consulta es lenta)
  5. Clic en la esquina del grid (selecciona todo) + Ctrl+C
  6. Leer el portapapeles -> DataFrame

Requisitos (sin admin):  py -m pip install --user pywinauto pandas pyperclip openpyxl
Usar Python de 64 bits (la app es de 64 bits). La sesión de Windows debe estar
desbloqueada: el paso 5 usa mouse/teclado reales.
"""
import csv
import ctypes
import io
import logging
import sys
import time
from datetime import datetime
from pathlib import Path

import pandas as pd
import pyperclip
from pywinauto import Application, Desktop
from pywinauto.keyboard import send_keys

EXE = r"\\192.168.83.27\hp2\KardexWmsSap.exe"
CARPETA_APP = r"\\192.168.83.27\hp2"  # la app lee ConfigKrx.xml de su carpeta de trabajo
TITULO = "HPC Consulta de Kardex entre WMS y SAP"
PESTANA = "ExistenciaWMS"
COLUMNAS = ["Ubicacion", "Codigo", "Descripcion", "Existencia", "Bodega"]
OPCIONES = {
    "con": "Solo con existencia",
    "todo": "Incluir todo",
    "sin": "Solo sin existencia",
    "negativa": "Negativa",
}
log = logging.getLogger("kardex_wms")
ESQUINA_GRID = (6, 6)  # px dentro del grid; ajustar si el clic no selecciona todo


# ---------- apertura ----------
def _aceptar_advertencia(timeout=15):
    """Si aparece 'Advertencia de seguridad de Abrir archivo', da clic en Ejecutar."""
    fin = time.time() + timeout
    while time.time() < fin:
        try:
            dlg = Desktop(backend="uia").window(title_re=r"Advertencia de seguridad.*")
            if dlg.exists(timeout=0.5):
                dlg.child_window(title="Ejecutar", control_type="Button").click()
                return True
        except Exception:
            pass
        try:  # ya abrió sin advertencia
            if Desktop(backend="win32").window(title=TITULO).exists(timeout=0.5):
                return False
        except Exception:
            pass
        time.sleep(0.5)
    return False


def abrir_app():
    try:
        app = Application(backend="win32").connect(title=TITULO, timeout=2)
    except Exception:
        Application(backend="win32").start(EXE, wait_for_idle=False, work_dir=CARPETA_APP)
        _aceptar_advertencia()
        app = Application(backend="win32").connect(title=TITULO, timeout=90)
    win = app.window(title=TITULO)
    win.wait("visible ready", timeout=90)
    win.set_focus()
    return win


# ---------- helpers de controles (los Id cambian en cada ejecución) ----------
def _visibles(win, clase):
    return [c for c in win.wrapper_object().descendants()
            if clase in c.class_name() and c.is_visible()]


def _por_texto(win, clase, texto):
    for c in _visibles(win, clase):
        if c.window_text().strip() == texto:
            return c
    raise LookupError(f"No encontré {clase} '{texto}' visible")


def _edit_de_etiqueta(win, etiqueta):
    """El EDIT que está a la derecha de una etiqueta 'Filtro xxx:'."""
    lab = _por_texto(win, "STATIC", etiqueta).rectangle()
    candidatos = []
    for e in _visibles(win, ".EDIT."):
        r = e.rectangle()
        if r.left >= lab.left and abs(r.mid_point().y - lab.mid_point().y) < 15:
            candidatos.append((r.left - lab.right, e))
    if not candidatos:
        raise LookupError(f"No encontré el campo de '{etiqueta}'")
    return min(candidatos, key=lambda t: t[0])[1]


def _grid(win):
    """El grid = la Window.8 visible sin título más grande de la pestaña."""
    cands = [c for c in _visibles(win, ".Window.8.") if c.window_text().strip() == ""]
    if not cands:
        raise LookupError("No encontré el grid")
    return max(cands, key=lambda c: c.rectangle().width() * c.rectangle().height())


def _esperar_respuesta(hwnd, timeout):
    """La app se congela mientras consulta: esperar a que vuelva a responder."""
    user32 = ctypes.windll.user32
    res = ctypes.c_size_t()
    fin = time.time() + timeout
    time.sleep(2)
    while time.time() < fin:
        ok = user32.SendMessageTimeoutW(hwnd, 0, 0, 0, 0x0002, 2000, ctypes.byref(res))
        if ok:
            return
        time.sleep(3)
    raise TimeoutError("La app no volvió a responder a tiempo")


# ---------- copia y parseo ----------
def _leer_portapapeles():
    try:
        return pyperclip.paste() or ""
    except Exception:  # la app puede tener el portapapeles abierto
        return ""


def _copiar_grid(grid, hwnd, timeout):
    """Un solo clic-esquina + Ctrl+C; luego espera a que el portapapeles se llene.
    Reintenta la copia solo cada 90 s (copiar miles de filas es lento)."""
    def copiar():
        grid.click_input(coords=ESQUINA_GRID)
        time.sleep(0.5)
        send_keys("^c")
        log.info("Ctrl+C enviado, esperando portapapeles...")

    pyperclip.copy("")
    copiar()
    fin = time.time() + timeout
    proximo = time.time() + 90
    while time.time() < fin:
        _esperar_respuesta(hwnd, timeout)
        txt = _leer_portapapeles()
        if len(txt.splitlines()) >= 2:
            log.info("Portapapeles: %s líneas", len(txt.splitlines()))
            return txt
        if time.time() > proximo:
            log.info("Portapapeles vacío, reintentando copia")
            copiar()
            proximo = time.time() + 90
        time.sleep(2)
    raise TimeoutError("El grid no devolvió datos a tiempo")


def _a_dataframe(txt):
    # csv respeta descripciones entre comillas con saltos de línea o comillas dobles (15"" CROMADA)
    filas = [f for f in csv.reader(io.StringIO(txt.strip("\r\n")), delimiter="\t", quotechar='"')
             if any(c.strip() for c in f)]
    df = pd.DataFrame(filas)
    # quitar columnas vacías (ej. encabezado de fila del grid)
    df = df.loc[:, ~df.fillna("").apply(lambda s: s.astype(str).str.strip().eq("").all())]
    df.columns = range(df.shape[1])
    if [str(x).strip() for x in df.iloc[0].tolist()][:len(COLUMNAS)] == COLUMNAS:
        df = df.iloc[1:]
    if df.shape[1] == len(COLUMNAS):
        df.columns = COLUMNAS
        df["Existencia"] = pd.to_numeric(df["Existencia"].str.strip().str.replace(",", "", regex=False), errors="coerce")
    for c in df.columns:
        if df[c].dtype == object:
            df[c] = df[c].str.strip()
    return df.reset_index(drop=True)


# ---------- paso principal ----------
def extraer_existencia_wms(opcion="con", bodega=None, codigo=None, ubicacion=None,
                           descripcion=None, timeout=900, salida=None):
    """
    opcion: 'con' | 'todo' | 'sin' | 'negativa'
    timeout: segundos máximos esperando la consulta (default 15 min)
    salida: ruta .xlsx opcional para guardar el resultado
    """
    log.info("Abriendo app")
    win = abrir_app()
    log.info("Pestaña %s", PESTANA)
    tab = win.child_window(class_name_re=r"WindowsForms10\.SysTabControl32.*").wrapper_object()
    tab.select(PESTANA)
    time.sleep(1.5)

    filtros = {"Filtro bodega:": bodega, "Filtro codigo:": codigo,
               "Filtro ubicacion:": ubicacion, "Filtro descripcion:": descripcion}
    for etiqueta, valor in filtros.items():
        campo = _edit_de_etiqueta(win, etiqueta)
        campo.set_edit_text(valor or "")

    _por_texto(win, ".BUTTON.", OPCIONES[opcion]).click()
    # Resolver todo ANTES de Actualizar: durante la consulta la ventana no responde
    # y Windows cambia su título a "(No responde)", así que no se puede buscar por título.
    hwnd = win.wrapper_object().handle
    grid = _grid(win)
    log.info("Actualizar...")
    _por_texto(win, ".BUTTON.", "Actualizar").click()
    _esperar_respuesta(hwnd, timeout)
    log.info("Consulta terminada, copiando grid")

    df = _a_dataframe(_copiar_grid(grid, hwnd, timeout))

    if salida:
        Path(salida).parent.mkdir(parents=True, exist_ok=True)
        df.to_excel(salida, index=False)
    return df


if __name__ == "__main__":
    destino = Path.home() / "auditoria" / f"existencia_wms_{datetime.now():%Y%m%d_%H%M}.xlsx"
    t0 = time.time()
    df = extraer_existencia_wms(salida=destino)
    print(f"Filas: {len(df)}  |  {time.time() - t0:.0f}s  ->  {destino}")
    print(df.head(10).to_string())
    sys.exit(0)
