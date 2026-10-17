"""
Builds the seed inbox attachments in seed/assets/.

The generated files are committed, so teammates don't need to run this.
Rebuild after editing (needs Python 3 with reportlab, Pillow and playwright):

    python3 seed/assets/build_assets.py

Every trap's evidence lives in these files on purpose:
  harbor-lobby-floor-plan.pdf p.2  -> scope is Levels 1-2, Level 3 NOT in scope
  lumen-quote-Q-2026-118.pdf       -> Status: PROPOSED, signature block blank
  vector-q4-reporting-requirements.pdf p.2 -> two items not in the original SOW
  lumen-scheduling-api-mapping.pdf p.2     -> API key pending (missing info)
"""

import io
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER, landscape
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent
INK = colors.HexColor("#1b1d21")
GREY = colors.HexColor("#6b6f76")
LINE = colors.HexColor("#c9c6bf")
RED = colors.HexColor("#c8102e")


def meta(c: canvas.Canvas, title: str, author: str) -> None:
    c.setTitle(title)
    c.setAuthor(author)
    c.setCreator("Client Pulse seed assets")


# --------------------------------------------------------------------- PDFs


def floor_plan() -> None:
    path = OUT / "harbor-lobby-floor-plan.pdf"
    W, H = landscape(LETTER)
    c = canvas.Canvas(str(path), pagesize=(W, H))
    meta(c, "Lobby redesign - marked-up floor plan", "Harbor & Pine Architects")

    def title_block(sheet: str, level: str) -> None:
        c.setStrokeColor(INK)
        c.setLineWidth(1)
        c.rect(0.4 * inch, 0.4 * inch, W - 0.8 * inch, H - 0.8 * inch)
        x0 = W - 3.4 * inch
        c.rect(x0, 0.4 * inch, 3.0 * inch, 1.6 * inch)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 11)
        c.drawString(x0 + 10, 1.75 * inch, "HARBOR & PINE ARCHITECTS")
        c.setFont("Helvetica", 8.5)
        c.drawString(x0 + 10, 1.55 * inch, "1200 Embarcadero Center - Atrium Lobby")
        c.drawString(x0 + 10, 1.38 * inch, "Lobby Redesign - Walkthrough markups")
        c.setFont("Helvetica-Bold", 9)
        c.drawString(x0 + 10, 1.12 * inch, level)
        c.setFont("Helvetica", 8)
        c.drawString(x0 + 10, 0.92 * inch, "Scale 1:100   Drawn: MR   Checked: DW")
        c.setFont("Helvetica-Bold", 16)
        c.drawRightString(x0 + 3.0 * inch - 10, 0.55 * inch, sheet)

    def room(x, y, w, h, label, fill=None):
        c.setStrokeColor(INK)
        c.setLineWidth(2.2)
        if fill:
            c.setFillColor(fill)
            c.rect(x, y, w, h, fill=1, stroke=1)
        else:
            c.rect(x, y, w, h)
        c.setFillColor(GREY)
        c.setFont("Helvetica", 8)
        c.drawCentredString(x + w / 2, y + h / 2 - 3, label)

    def cloud(x, y, r, note, nx, ny):
        c.setStrokeColor(RED)
        c.setLineWidth(1.6)
        c.circle(x, y, r)
        c.line(x + r * 0.7, y + r * 0.7, nx, ny)
        c.setFillColor(RED)
        c.setFont("Helvetica-Oblique", 10)
        c.drawString(nx + 4, ny - 3, note)

    # Page 1: Level 1 (Ground)
    title_block("A-101", "LEVEL 1 - GROUND / RECEPTION")
    ox, oy = 0.9 * inch, 1.0 * inch
    c.setLineWidth(3)
    c.setStrokeColor(INK)
    c.rect(ox, oy, 6.6 * inch, 5.6 * inch)
    room(ox + 0.3 * inch, oy + 4.1 * inch, 1.6 * inch, 1.2 * inch, "ELEVATORS")
    room(ox + 2.6 * inch, oy + 2.4 * inch, 1.8 * inch, 0.6 * inch, "RECEPTION DESK", colors.HexColor("#f3efe6"))
    room(ox + 4.9 * inch, oy + 3.6 * inch, 1.4 * inch, 1.7 * inch, "SEATING")
    room(ox + 0.3 * inch, oy + 0.3 * inch, 1.4 * inch, 1.6 * inch, "MAIL / PKG")
    c.setStrokeColor(INK)
    c.setLineWidth(1)
    c.line(ox + 2.9 * inch, oy, ox + 3.9 * inch, oy)
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(INK)
    c.drawCentredString(ox + 3.4 * inch, oy - 14, "MAIN ENTRY")
    c.setFillColor(GREY)
    c.setFont("Helvetica", 8)
    c.drawString(ox + 2.6 * inch, oy + 3.25 * inch, "FEATURE / DONOR WALL")
    c.setStrokeColor(GREY)
    c.line(ox + 2.4 * inch, oy + 3.4 * inch, ox + 4.6 * inch, oy + 3.4 * inch)
    cloud(ox + 3.5 * inch, oy + 2.7 * inch, 0.75 * inch, "Shift desk 1.2 m east", ox + 7.0 * inch, oy + 3.4 * inch)
    cloud(ox + 1.1 * inch, oy + 4.7 * inch, 0.55 * inch, "New lighting at elevator core", ox + 7.0 * inch, oy + 4.9 * inch)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(0.7 * inch, H - 0.8 * inch, "LEVEL 1 (GROUND) - MARKED-UP PLAN")
    c.showPage()

    # Page 2: Level 2 (Mezzanine) + scope note
    title_block("A-102", "LEVEL 2 - MEZZANINE")
    c.setLineWidth(3)
    c.setStrokeColor(INK)
    c.rect(ox, oy + 1.4 * inch, 6.6 * inch, 4.2 * inch)
    room(ox + 0.3 * inch, oy + 4.1 * inch, 1.6 * inch, 1.2 * inch, "ELEVATORS")
    room(ox + 2.3 * inch, oy + 2.0 * inch, 3.9 * inch, 1.1 * inch, "OPEN TO BELOW (ATRIUM)")
    room(ox + 4.6 * inch, oy + 4.0 * inch, 1.7 * inch, 1.3 * inch, "LOUNGE")
    cloud(ox + 4.2 * inch, oy + 2.5 * inch, 0.6 * inch, "Pendant cluster over atrium", ox + 7.0 * inch, oy + 3.1 * inch)

    nx, ny = ox, oy - 0.1 * inch
    c.setFillColor(colors.HexColor("#fff4f4"))
    c.setStrokeColor(RED)
    c.setLineWidth(1.4)
    c.rect(nx, ny, 6.6 * inch, 1.25 * inch, fill=1, stroke=1)
    c.setFillColor(RED)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(nx + 10, ny + 1.0 * inch, "SCOPE OF WORK")
    c.setFillColor(INK)
    c.setFont("Helvetica", 10)
    c.drawString(nx + 10, ny + 0.78 * inch, "Lobby redesign covers 2 levels: Level 1 (Ground) and Level 2 (Mezzanine).")
    c.drawString(nx + 10, ny + 0.56 * inch, "Level 3 (tenant floor) is NOT IN SCOPE. Lighting and signage by landlord.")
    c.setFillColor(GREY)
    c.setFont("Helvetica-Oblique", 9)
    c.drawString(nx + 10, ny + 0.3 * inch, "Per walkthrough markups, DW / MR.")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 13)
    c.drawString(0.7 * inch, H - 0.8 * inch, "LEVEL 2 (MEZZANINE) - MARKED-UP PLAN")
    c.showPage()
    c.save()


def doc_header(c, W, H, org, title, sub):
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(0.8 * inch, H - 0.9 * inch, org)
    c.setFont("Helvetica", 10)
    c.setFillColor(GREY)
    c.drawString(0.8 * inch, H - 1.12 * inch, sub)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 20)
    c.drawString(0.8 * inch, H - 1.7 * inch, title)
    c.setStrokeColor(LINE)
    c.line(0.8 * inch, H - 1.85 * inch, W - 0.8 * inch, H - 1.85 * inch)


def table(c, x, y, cols, rows, widths, row_h=0.32 * inch, bold_last=False):
    c.setFont("Helvetica-Bold", 9.5)
    c.setFillColor(GREY)
    cx = x
    for col, w in zip(cols, widths):
        c.drawString(cx + 4, y, col)
        cx += w
    c.setStrokeColor(LINE)
    c.line(x, y - 6, x + sum(widths), y - 6)
    for i, row in enumerate(rows):
        yy = y - (i + 1) * row_h
        last = bold_last and i == len(rows) - 1
        c.setFont("Helvetica-Bold" if last else "Helvetica", 10)
        c.setFillColor(INK)
        cx = x
        for j, (cell, w) in enumerate(zip(row, widths)):
            if j == len(row) - 1 and cell.startswith("$"):
                c.drawRightString(cx + w - 4, yy, cell)
            else:
                c.drawString(cx + 4, yy, cell)
            cx += w
        c.setStrokeColor(LINE)
        c.line(x, yy - 8, x + sum(widths), yy - 8)
    return y - (len(rows) + 1) * row_h


def purchase_order() -> None:
    W, H = LETTER
    c = canvas.Canvas(str(OUT / "harbor-po-4471.pdf"), pagesize=LETTER)
    meta(c, "Purchase Order 4471", "Harbor & Pine Architects")
    doc_header(c, W, H, "Harbor & Pine Architects", "Purchase Order 4471", "Accounts Payable - ap@harborpine.com")
    c.setFont("Helvetica", 10)
    c.setFillColor(INK)
    y = H - 2.3 * inch
    for k, v in [("Vendor", "Northbeam Studio"), ("Project", "1200 Embarcadero - Lobby redesign, phase 1"), ("Terms", "Net 30")]:
        c.setFont("Helvetica-Bold", 10)
        c.drawString(0.8 * inch, y, k)
        c.setFont("Helvetica", 10)
        c.drawString(2.0 * inch, y, v)
        y -= 0.25 * inch
    y = table(
        c,
        0.8 * inch,
        y - 0.3 * inch,
        ["Line", "Description", "Amount"],
        [
            ["1", "Concept design", "$12,000.00"],
            ["2", "Lighting plan (Levels 1-2)", "$14,500.00"],
            ["3", "Signage package", "$12,000.00"],
            ["", "Total", "$38,500.00"],
        ],
        [0.7 * inch, 4.6 * inch, 1.6 * inch],
        bold_last=True,
    )
    c.setFillColor(RED)
    c.setFont("Helvetica-Bold", 10.5)
    c.drawString(0.8 * inch, y - 0.2 * inch, "Reference PO 4471 on every invoice. Invoices without a PO number are returned unpaid.")
    c.save()


def q4_requirements() -> None:
    W, H = LETTER
    c = canvas.Canvas(str(OUT / "vector-q4-reporting-requirements.pdf"), pagesize=LETTER)
    meta(c, "Q4 reporting requirements - Route dashboard", "Vector Freight Finance")
    doc_header(c, W, H, "Vector Freight", "Q4 Reporting Requirements", "Route dashboard - prepared by Finance")
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(INK)
    c.drawString(0.8 * inch, H - 2.3 * inch, "1. Existing metrics (in current scope)")
    table(
        c,
        0.8 * inch,
        H - 2.7 * inch,
        ["Metric", "Definition", "Cadence"],
        [
            ["On-time delivery %", "Stops completed inside the promised window", "Daily"],
            ["Dwell time by depot", "Median minutes at depot per route", "Daily"],
            ["Route adherence", "Share of stops served in planned order", "Weekly"],
        ],
        [1.8 * inch, 3.6 * inch, 1.5 * inch],
    )
    c.setFont("Helvetica-Oblique", 9)
    c.setFillColor(GREY)
    c.drawString(0.8 * inch, 0.8 * inch, "Page 1 of 2")
    c.showPage()

    doc_header(c, W, H, "Vector Freight", "Q4 Reporting Requirements", "Route dashboard - prepared by Finance")
    c.setFont("Helvetica-Bold", 12)
    c.setFillColor(RED)
    c.drawString(0.8 * inch, H - 2.3 * inch, "2. New for Q4 (not in original SOW)")
    table(
        c,
        0.8 * inch,
        H - 2.7 * inch,
        ["Item", "Requirement", "Owner"],
        [
            ["CO2 per route", "Estimated grams CO2 per km for each route, by vehicle type", "Finance"],
            ["Weekly CSV export", "Every Monday 06:00 PT to finance@vectorfreight.io", "Finance"],
        ],
        [1.8 * inch, 3.9 * inch, 1.2 * inch],
    )
    c.setFont("Helvetica", 10)
    c.setFillColor(INK)
    c.drawString(0.8 * inch, H - 4.0 * inch, "Please provide a scope and estimate for both items before work begins.")
    c.setFont("Helvetica-Oblique", 9)
    c.setFillColor(GREY)
    c.drawString(0.8 * inch, 0.8 * inch, "Page 2 of 2")
    c.save()


def quote() -> None:
    W, H = LETTER
    c = canvas.Canvas(str(OUT / "lumen-quote-Q-2026-118.pdf"), pagesize=LETTER)
    meta(c, "Quote Q-2026-118", "Northbeam Studio")
    doc_header(c, W, H, "Northbeam Studio", "Quote Q-2026-118", "sam@northbeam.studio - Prepared for Lumen Clinic")
    c.setFillColor(colors.HexColor("#fff7e6"))
    c.setStrokeColor(colors.HexColor("#d99a00"))
    c.roundRect(W - 3.4 * inch, H - 1.35 * inch, 2.6 * inch, 0.45 * inch, 6, fill=1, stroke=1)
    c.setFillColor(colors.HexColor("#8a5a00"))
    c.setFont("Helvetica-Bold", 11)
    c.drawCentredString(W - 2.1 * inch, H - 1.18 * inch, "STATUS: PROPOSED")
    y = table(
        c,
        0.8 * inch,
        H - 2.4 * inch,
        ["Item", "Description", "Amount"],
        [
            ["1", "Patient portal login page (design + build)", "$4,800.00"],
            ["2", "Spanish versions of 6 services pages", "$7,600.00"],
            ["", "Total (excl. tax)", "$12,400.00"],
        ],
        [0.7 * inch, 4.6 * inch, 1.6 * inch],
        bold_last=True,
    )
    c.setFont("Helvetica", 10)
    c.setFillColor(INK)
    c.drawString(0.8 * inch, y - 0.1 * inch, "Adds approximately 3 weeks to the website refresh timeline.")
    c.drawString(0.8 * inch, y - 0.35 * inch, "This quote is valid for 30 days and becomes binding only when signed below.")
    sy = y - 1.3 * inch
    c.setFont("Helvetica-Bold", 10)
    c.drawString(0.8 * inch, sy + 0.25 * inch, "Client acceptance")
    c.setStrokeColor(INK)
    for i, lbl in enumerate(["Signature", "Name", "Date"]):
        yy = sy - i * 0.45 * inch
        c.line(1.7 * inch, yy, 4.6 * inch, yy)
        c.setFont("Helvetica", 9)
        c.setFillColor(GREY)
        c.drawString(0.8 * inch, yy + 2, lbl)
    c.save()


def api_mapping() -> None:
    W, H = LETTER
    c = canvas.Canvas(str(OUT / "lumen-scheduling-api-mapping.pdf"), pagesize=LETTER)
    meta(c, "CareSlot integration - field mapping", "Lumen Clinic IT")
    doc_header(c, W, H, "Lumen Clinic", "CareSlot Integration: Field Mapping", "Prepared by IT contractor")
    table(
        c,
        0.8 * inch,
        H - 2.4 * inch,
        ["Website booking form", "CareSlot field", "Notes"],
        [
            ["Patient first / last name", "patient.given / patient.family", "Required"],
            ["Date of birth", "patient.birthDate", "YYYY-MM-DD"],
            ["Provider", "practitioner.id", "Provider ID list TBD"],
            ["Appointment type", "serviceType.code", "8 types"],
            ["Preferred slot", "slot.start / slot.end", "15-min grid"],
        ],
        [2.4 * inch, 2.6 * inch, 1.9 * inch],
    )
    c.setFont("Helvetica-Oblique", 9)
    c.setFillColor(GREY)
    c.drawString(0.8 * inch, 0.8 * inch, "Page 1 of 2")
    c.showPage()
    doc_header(c, W, H, "Lumen Clinic", "CareSlot Integration: Open Items", "Prepared by IT contractor")
    table(
        c,
        0.8 * inch,
        H - 2.4 * inch,
        ["Item", "Status", "Blocking?"],
        [
            ["CareSlot API key", "PENDING: vendor requires signed BAA", "Yes"],
            ["Sandbox environment", "Not provisioned", "Yes"],
            ["Provider ID list", "TBD from front desk", "No"],
            ["Webhook for cancellations", "Vendor confirming support", "No"],
        ],
        [2.2 * inch, 3.2 * inch, 1.5 * inch],
    )
    c.setFont("Helvetica-Oblique", 9)
    c.setFillColor(GREY)
    c.drawString(0.8 * inch, 0.8 * inch, "Page 2 of 2")
    c.save()


def revised_scope() -> None:
    W, H = LETTER
    c = canvas.Canvas(str(OUT / "harbor-revised-scope-v2.pdf"), pagesize=LETTER)
    meta(c, "Revised scope v2", "Harbor & Pine Architects")
    doc_header(c, W, H, "Harbor & Pine Architects", "Lobby Redesign: Revised Scope v2", "For Northbeam Studio")
    c.setFont("Helvetica", 11)
    c.setFillColor(INK)
    lines = [
        "Scope: Level 1 (Ground) and Level 2 (Mezzanine) only.",
        "Lighting: reception desk, elevator core, atrium pendant cluster.",
        "Signage: wayfinding for Levels 1-2 and the donor wall (6.2 m).",
        "",
        "Please confirm this scope and the updated fee by Thursday.",
    ]
    for i, t in enumerate(lines):
        c.drawString(0.8 * inch, H - 2.4 * inch - i * 0.3 * inch, t)
    c.save()


# ------------------------------------------------------------ screenshots

BASE_CSS = """
* { box-sizing: border-box; margin: 0; }
body { font-family: Inter, 'DejaVu Sans', sans-serif; -webkit-font-smoothing: antialiased; }
"""


def shoot(html: str, path: Path, w: int, h: int, scale: float = 1.0, jpeg: bool = False) -> None:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": w, "height": h}, device_scale_factor=scale)
        pg.set_content(f"<style>{BASE_CSS}</style>{html}")
        pg.wait_for_timeout(150)
        if jpeg:
            pg.screenshot(path=str(path), type="jpeg", quality=88)
        else:
            pg.screenshot(path=str(path))
        b.close()


def dashboard_bug() -> None:
    rows = "".join(
        f"<tr><td>{r}</td><td>{d}</td><td>{s}</td><td class='eta'>06:40</td><td><span class='stale'>stale</span></td></tr>"
        for r, d, s in [
            ("SF-12", "Oakland", "14 / 31"),
            ("SF-07", "Oakland", "9 / 28"),
            ("SJ-03", "San Jose", "21 / 40"),
            ("EB-22", "Hayward", "5 / 26"),
            ("SF-19", "Oakland", "17 / 33"),
            ("PN-04", "Fremont", "11 / 24"),
        ]
    )
    html = f"""
<style>
body {{ background:#eef0f3; }}
.chrome {{ height:38px; background:#dfe2e6; display:flex; align-items:center; gap:8px; padding:0 14px; }}
.chrome i {{ width:12px; height:12px; border-radius:50%; display:inline-block; }}
.url {{ margin-left:16px; flex:1; height:24px; background:#fff; border-radius:6px; font:12px Inter; color:#555; display:flex; align-items:center; padding:0 10px; }}
.app {{ display:grid; grid-template-columns:210px 1fr; height:682px; }}
.side {{ background:#0f2537; color:#c5d3df; padding:18px 16px; font-size:13px; }}
.side b {{ color:#fff; font-size:15px; display:block; margin-bottom:22px; }}
.side div {{ padding:8px 6px; border-radius:6px; }}
.side .on {{ background:#1d3a52; color:#fff; }}
.main {{ padding:20px 24px; }}
h1 {{ font-size:20px; color:#14202b; }}
.sub {{ color:#6b7785; font-size:12px; margin:4px 0 14px; }}
.badge {{ background:#fde8e8; color:#b42318; border:1px solid #f5b5b5; font-size:12px; padding:3px 8px; border-radius:999px; margin-left:8px; }}
.grid {{ display:grid; grid-template-columns: 1.4fr 1fr; gap:16px; }}
.card {{ background:#fff; border:1px solid #dde2e8; border-radius:10px; padding:14px; }}
.map {{ height:520px; background:repeating-linear-gradient(45deg,#e7eaee 0 12px,#eef1f4 12px 24px); border-radius:8px; display:flex; align-items:center; justify-content:center; }}
.err {{ background:#fff; border:1px solid #f1a7a7; border-left:4px solid #d92d20; padding:14px 18px; border-radius:8px; font-size:14px; color:#7a1d16; box-shadow:0 6px 18px rgba(0,0,0,.08); }}
.err b {{ display:block; color:#b42318; margin-bottom:4px; }}
table {{ width:100%; border-collapse:collapse; font-size:13px; }}
th {{ text-align:left; color:#6b7785; font-weight:600; font-size:11px; text-transform:uppercase; padding:8px 6px; border-bottom:1px solid #e3e7ec; }}
td {{ padding:9px 6px; border-bottom:1px solid #eef1f4; color:#14202b; }}
.eta {{ font-family:'DejaVu Sans Mono',monospace; }}
.stale {{ background:#fff4e5; color:#9a5b00; border-radius:4px; padding:1px 6px; font-size:11px; }}
</style>
<div class="chrome"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
<div class="url">routes.vectorfreight.io/ops/live</div></div>
<div class="app">
 <div class="side"><b>Vector Freight</b><div class="on">Live routes</div><div>Depots</div><div>Drivers</div><div>Reports</div></div>
 <div class="main">
  <h1>Live routes - Bay Area <span class="badge">Last updated 06:40 - data stale</span></h1>
  <div class="sub">Dispatch view - auto-refresh every 30 s</div>
  <div class="grid">
   <div class="card"><div class="map"><div class="err"><b>Map tiles failed to load (503)</b>Service Unavailable - tiles.vectorfreight.io<br>Retrying... attempt 14</div></div></div>
   <div class="card"><table><tr><th>Route</th><th>Depot</th><th>Stops</th><th>ETA</th><th></th></tr>{rows}</table></div>
  </div>
 </div>
</div>"""
    shoot(html, OUT / "vector-route-dashboard-bug.png", 1440, 720)


def app_crash() -> None:
    html = """
<style>
body { background:#111; }
.phone { width:390px; height:844px; background:#f4f5f7; position:relative; overflow:hidden; font-family:'DejaVu Sans',sans-serif; }
.status { height:30px; background:#1f2a37; color:#fff; font-size:12px; display:flex; justify-content:space-between; padding:7px 14px; }
.bar { background:#1f6feb; color:#fff; padding:14px 16px; font-size:17px; font-weight:600; }
.content { padding:16px; opacity:.45; }
.box { background:#fff; border-radius:10px; padding:14px; margin-bottom:12px; font-size:14px; color:#222; }
.photo { height:220px; background:#cfd6de; border-radius:8px; display:flex; align-items:center; justify-content:center; color:#555; }
.btn { background:#1f6feb; color:#fff; text-align:center; padding:12px; border-radius:8px; margin-top:10px; }
.scrim { position:absolute; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; }
.dlg { width:300px; background:#fff; border-radius:24px; padding:22px 22px 10px; box-shadow:0 10px 30px rgba(0,0,0,.3); }
.dlg h3 { font-size:19px; font-weight:500; color:#1b1b1f; margin-bottom:18px; }
.opt { display:flex; align-items:center; gap:14px; padding:12px 0; font-size:15px; color:#1b1b1f; }
.ic { width:22px; height:22px; border-radius:50%; border:2px solid #45464f; }
.foot { position:absolute; bottom:0; left:0; right:0; background:#1f2a37; color:#c7d0da; font-size:11px; padding:8px 14px; font-family:'DejaVu Sans Mono',monospace; }
</style>
<div class="phone">
 <div class="status"><span>9:41</span><span>LTE 62%</span></div>
 <div class="bar">Proof of delivery - Stop 14</div>
 <div class="content">
  <div class="box">1849 Harrison St, Oakland<br><small>Signature captured</small></div>
  <div class="box"><div class="photo">Uploading photo... 38%</div><div class="btn">Upload photo</div></div>
 </div>
 <div class="scrim"><div class="dlg"><h3>Vector Driver keeps stopping</h3>
  <div class="opt"><span class="ic"></span>App info</div>
  <div class="opt"><span class="ic"></span>Close app</div>
  <div class="opt"><span class="ic"></span>Send feedback</div></div></div>
 <div class="foot">build 0.9.3 (214) - Pixel 7 - Android 15</div>
</div>"""
    shoot(html, OUT / "vector-driver-app-crash.png", 390, 844, scale=2)


def double_booking() -> None:
    days = ["Mon", "Tue", "Wed", "Thu", "Fri"]
    hours = ["9:00", "9:30", "10:00", "10:30", "11:00", "11:30", "1:00", "1:30", "2:00", "2:15", "2:30", "3:00"]
    appts = {
        ("Mon", "9:30"): ["R. Alvarez - Annual physical"],
        ("Mon", "11:00"): ["T. Nguyen - Follow-up"],
        ("Tue", "9:00"): ["K. Brooks - New patient"],
        ("Tue", "10:30"): ["J. Park - Consult", "M. Diaz - Consult"],
        ("Wed", "10:00"): ["S. Okoye - Lab review"],
        ("Wed", "1:30"): ["L. Chen - Vaccination"],
        ("Thu", "11:30"): ["A. Rossi - Follow-up"],
        ("Thu", "2:15"): ["P. Singh - Physical", "E. Moore - Physical"],
        ("Fri", "9:30"): ["D. Wright - Consult"],
        ("Fri", "3:00"): ["H. Ali - New patient"],
    }
    cells = ""
    for h in hours:
        cells += f"<div class='t'>{h}</div>"
        for d in days:
            a = appts.get((d, h), [])
            if len(a) > 1:
                cells += "<div class='c conflict'>" + "".join(f"<div class='ap red'>{x}</div>" for x in a) + "<span class='warn'>! Double-booked</span></div>"
            elif a:
                cells += f"<div class='c'><div class='ap'>{a[0]}</div></div>"
            else:
                cells += "<div class='c'></div>"
    head = "<div></div>" + "".join(f"<div class='h'>{d}</div>" for d in days)
    html = f"""
<style>
body {{ background:#fff; padding:20px 24px; font-family:Inter,'DejaVu Sans',sans-serif; }}
h1 {{ font-size:19px; color:#20323a; }}
.sub {{ color:#6a7b82; font-size:12px; margin:4px 0 14px; }}
.cal {{ display:grid; grid-template-columns:64px repeat(5, 1fr); border-top:1px solid #e1e7ea; border-left:1px solid #e1e7ea; }}
.cal > div {{ border-right:1px solid #e1e7ea; border-bottom:1px solid #e1e7ea; min-height:46px; }}
.h {{ background:#f3f7f6; font-weight:600; font-size:13px; padding:10px; color:#20323a; min-height:auto !important; }}
.t {{ font-size:11px; color:#6a7b82; padding:6px; }}
.c {{ padding:3px; position:relative; }}
.ap {{ background:#e3f1ec; border-left:3px solid #4f8f7a; font-size:11px; padding:4px 6px; border-radius:4px; color:#1e3b33; margin-bottom:2px; }}
.ap.red {{ background:#fdecec; border-left-color:#d92d20; color:#7a1d16; }}
.conflict {{ background:#fff6f6; outline:2px solid #d92d20; outline-offset:-2px; }}
.warn {{ font-size:10px; font-weight:700; color:#b42318; }}
</style>
<h1>Lumen Clinic - Front desk schedule</h1><div class="sub">Dr. Okafor - Week view - CareSlot web booking enabled</div>
<div class="cal">{head}{cells}</div>"""
    shoot(html, OUT / "lumen-double-booking.png", 1200, 760)


def moodboard() -> None:
    sw = [("#8FA68E", "Sage"), ("#E9E4D8", "Linen"), ("#2F3E36", "Forest ink"), ("#C9A27E", "Clay"), ("#F7F5F0", "Paper")]
    swatches = "".join(f"<div class='sw'><div style='background:{c}'></div><span>{n}<br><code>{c}</code></span></div>" for c, n in sw)
    html = f"""
<style>
body {{ background:#F7F5F0; padding:36px; font-family:'DejaVu Sans',sans-serif; color:#2F3E36; }}
.top {{ display:flex; justify-content:space-between; align-items:baseline; }}
.k {{ font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:#6b766f; }}
h1 {{ font-family:'DejaVu Serif',Georgia,serif; font-weight:400; font-size:58px; margin:18px 0 6px; }}
p {{ font-size:16px; color:#4b5a51; max-width:520px; }}
.row {{ display:grid; grid-template-columns: 1.2fr 1fr 1fr; gap:16px; margin-top:28px; }}
.img {{ border-radius:14px; height:230px; }}
.sws {{ display:flex; gap:14px; margin-top:28px; }}
.sw div {{ width:120px; height:80px; border-radius:10px; border:1px solid rgba(0,0,0,.08); }}
.sw span {{ display:block; font-size:12px; margin-top:6px; }}
code {{ color:#6b766f; }}
.type {{ margin-top:26px; display:flex; gap:40px; font-size:13px; color:#4b5a51; }}
.type b {{ font-family:'DejaVu Serif',serif; font-weight:400; font-size:26px; color:#2F3E36; display:block; }}
</style>
<div class="top"><span class="k">Lumen Clinic - Website refresh</span><span class="k">Moodboard - partners' pick</span></div>
<h1>Care that listens.</h1>
<p>Calm, warm and clinical without feeling cold. Sage green as the primary, serif headings, generous white space.</p>
<div class="row">
 <div class="img" style="background:linear-gradient(135deg,#a9bca6,#6f8a6d)"></div>
 <div class="img" style="background:linear-gradient(160deg,#efe9dc,#c9a27e)"></div>
 <div class="img" style="background:linear-gradient(140deg,#dfe7dc,#8FA68E)"></div>
</div>
<div class="sws">{swatches}</div>
<div class="type"><div><b>Serif headings</b>Display / H1-H3</div><div><b style="font-family:'DejaVu Sans'">Sans body text</b>Body / UI, 16 px</div></div>"""
    shoot(html, OUT / "lumen-website-moodboard.png", 1200, 700)


def site_photo() -> None:
    """A phone photo of a printed elevation taped to the wall, marked up in red pen."""
    elevation = """
<style>
body { background:transparent; }
.sheet { width:900px; height:620px; background:#fbfaf6; position:relative; padding:28px; font-family:'DejaVu Sans',sans-serif; color:#222; }
.title { font-size:15px; font-weight:700; letter-spacing:.04em; }
.small { font-size:11px; color:#555; }
svg { position:absolute; left:40px; top:80px; }
.pen { font-family:'DejaVu Sans',sans-serif; font-style:italic; color:#c8102e; position:absolute; font-weight:700; transform:rotate(-4deg); }
</style>
<div class="sheet">
 <div class="title">RECEPTION WALL - ELEVATION A</div>
 <div class="small">Harbor &amp; Pine Architects - Lobby redesign - 1:50</div>
 <svg width="820" height="500" viewBox="0 0 820 500">
  <rect x="40" y="60" width="740" height="340" fill="none" stroke="#222" stroke-width="3"/>
  <rect x="300" y="250" width="240" height="150" fill="#ece7dc" stroke="#222" stroke-width="2"/>
  <text x="420" y="330" font-size="14" text-anchor="middle" fill="#444">RECEPTION DESK</text>
  <rect x="570" y="110" width="180" height="200" fill="none" stroke="#222" stroke-dasharray="6 5" stroke-width="2"/>
  <text x="660" y="215" font-size="13" text-anchor="middle" fill="#444">DONOR WALL</text>
  <rect x="330" y="110" width="180" height="70" fill="none" stroke="#222" stroke-width="2"/>
  <text x="420" y="150" font-size="13" text-anchor="middle" fill="#444">SIGNAGE</text>
  <line x1="40" y1="440" x2="780" y2="440" stroke="#222" stroke-width="1.5"/>
  <text x="410" y="465" font-size="15" text-anchor="middle" fill="#222">5.8 m</text>
  <line x1="380" y1="470" x2="440" y2="452" stroke="#c8102e" stroke-width="4"/>
  <line x1="380" y1="452" x2="440" y2="470" stroke="#c8102e" stroke-width="4"/>
  <ellipse cx="150" cy="210" rx="120" ry="95" fill="none" stroke="#c8102e" stroke-width="4"/>
  <path d="M570 200 C 470 120, 330 110, 260 170" fill="none" stroke="#c8102e" stroke-width="4"/>
  <path d="M260 170 l 22 -2 m -22 2 l 8 20" stroke="#c8102e" stroke-width="4" fill="none"/>
 </svg>
 <div class="pen" style="left:470px; top:578px; font-size:34px;">6.2 m measured</div>
 <div class="pen" style="left:85px; top:395px; font-size:22px;">donor wall here<br>(left of desk)</div>
</div>"""
    tmp = OUT / "_elevation.png"
    shoot(elevation, tmp, 900, 620, scale=1)
    sheet = Image.open(tmp).convert("RGBA")
    tmp.unlink()

    W, H = 1600, 1200
    rnd = random.Random(7)
    wall = Image.new("RGB", (W, H), (214, 205, 190))
    px = wall.load()
    for y in range(H):
        for x in range(0, W, 2):
            n = rnd.randint(-9, 9)
            r, g, b = px[x, y]
            px[x, y] = (r + n, g + n, b + n)
            if x + 1 < W:
                px[x + 1, y] = (r + n, g + n, b + n)
    wall = wall.filter(ImageFilter.GaussianBlur(1.2))

    sheet = sheet.resize((1100, 758)).rotate(-3.2, expand=True, resample=Image.BICUBIC)
    shadow = Image.new("RGBA", sheet.size, (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 90), mask=sheet.split()[3])
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    ox, oy = (W - sheet.width) // 2, (H - sheet.height) // 2 + 10
    wall.paste(shadow, (ox + 14, oy + 18), shadow)
    wall.paste(sheet, (ox, oy), sheet)

    d = ImageDraw.Draw(wall, "RGBA")
    for tx, ty in [(ox + 60, oy + 20), (ox + sheet.width - 150, oy + 50), (ox + 80, oy + sheet.height - 60), (ox + sheet.width - 170, oy + sheet.height - 40)]:
        d.rectangle([tx, ty, tx + 90, ty + 26], fill=(240, 232, 200, 200))

    vignette = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vignette)
    vd.ellipse([-W * 0.2, -H * 0.2, W * 1.2, H * 1.2], fill=255)
    vignette = vignette.filter(ImageFilter.GaussianBlur(160))
    dark = Image.new("RGB", (W, H), (40, 34, 28))
    photo = Image.composite(wall, dark, vignette)
    warm = Image.new("RGB", (W, H), (255, 236, 205))
    photo = Image.blend(photo, warm, 0.06)
    photo.save(OUT / "harbor-reception-wall-markup.jpg", quality=86)


def main() -> None:
    floor_plan()
    purchase_order()
    q4_requirements()
    quote()
    api_mapping()
    revised_scope()
    dashboard_bug()
    app_crash()
    double_booking()
    moodboard()
    site_photo()
    for f in sorted(OUT.iterdir()):
        if f.suffix in {".pdf", ".png", ".jpg"}:
            print(f"{f.name:45s} {f.stat().st_size // 1024:5d} KB")


if __name__ == "__main__":
    main()
