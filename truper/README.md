# Robot Catálogo Truper

Extrae **todos los productos** del Catálogo Vigente de Truper (https://www.truper.com/CatVigente/) — ~682 páginas, ~4,807 módulos, ~15,191 productos — a Excel, CSV y JSON. Solo HTTP + cheerio: sin navegador, sin IA, sin tokens. **No trae precios** (en el catálogo web solo vienen en las imágenes).

| | |
|---|---|
| Tarea | "HPC Truper" · día 1 de cada mes, 2:00 (si la PC estaba apagada, corre al encender) |
| Duración | 2–3 h (3 peticiones simultáneas, pausa 0.8 s) |
| PC | HPCLPJCOTUC · dungeon: nivel **Común** |
| Salida | `salida\truper_catalogo.xlsx` (hojas Productos + Especificaciones), `truper_productos.csv`, `truper_productos.json` |
| Log | `logs\consola-AAAA-MM-DD.log` |

## Instalar (una vez)
```powershell
cd C:\Users\jcotuc\source\repos\hpc-robots\truper
.\setup.cmd
.\programar-tarea.cmd
```
En `.env` llenar `MONITOR_*` (en esta PC son los mismos de `correos\.env`).

## Uso
```powershell
cd C:\Users\jcotuc\source\repos\hpc-robots\truper
npm run prueba        # 20 productos en consola (~7 min, no reporta al dungeon)
.\correr.cmd          # corrida completa, retoma donde iba si se cortó
.\correr.cmd --nuevo  # desde cero (borra lista y caché)
schtasks /Run /TN "HPC Truper"
```
- La lista (`codigos.json`) y el caché (`cache\`) se renuevan solos si tienen más de 20 días (`DIAS_REFRESCO`): la tarea mensual siempre trae el catálogo nuevo; una corrida cortada retoma.
- Fichas con error no se guardan en caché: volver a correr `correr.cmd` reintenta solo esas.

## Dungeon y Jefe
- Durante la corrida reporta cada minuto el avance (`Fichas 4210/15191 · 0 errores`) y el código en curso; el cuarto muestra la barra de avance.
- Terminado y al día → se va a la cafetería. Si no corre entre meses **no es falla** (como Garantías).
- El Jefe avisa (severidad media): catálogo del mes sin descargar desde el día 3, corrida detenida a medias (>30 min sin reportar), o terminada en ERROR (>2 % de fichas con error o >5 % sin nombre).

## Si deja de funcionar
- **Columnas vacías / fichas sin nombre** → Truper cambió el HTML de la ficha: revisar selectores en `parseFicha()`.
- **0 módulos / 0 productos** → cambió `data-modulo` o el endpoint `ficha/fichas` (el robot termina en ERROR).
- **HTTP 403/429** → subir `DELAY_MS` o bajar `CONCURRENCY` en `.env`.

Cómo está armado el sitio (endpoints, plantillas de ficha): ver comentarios en `scraper.mjs`.
