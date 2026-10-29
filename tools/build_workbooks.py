#!/usr/bin/env python3
"""Builds the monthly data collection workbook from shared/schema.json.

  python3 tools/build_workbooks.py            -> templates/Assura_Elevate_Monthly_Data_Template.xlsx
  python3 tools/build_workbooks.py --samples  -> also samples/xlsx/<code>/<period>.xlsx from samples/json

The template is never sent as it is. Its locked fields (company code, name, month and workbook
reference) hold placeholders such as {{company_code}}; the portal fills them for one client and
one month when the workbook is sent (shared/workbook.js). The sheet holding those placeholders is
stored uncompressed in the file so the portal can fill it without an unzip library.
"""
import zipfile
import json
import sys
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Protection, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "shared" / "schema.json").read_text())

NAVY = "221D17"  # espresso, from the pitch deck (name kept for the header and title styles)
GOLD = "DFA500"
PALE = "FAF7ED"
LOCKED = "F2EDDC"  # beige: filled in by Assura Elevate
HEAD_FONT = Font(name="Calibri", bold=True, color="FFFFFF", size=11)
TITLE_FONT = Font(name="Calibri", bold=True, color=NAVY, size=16)
SUB_FONT = Font(name="Calibri", italic=True, color="574D3E", size=10)
HEAD_FILL = PatternFill("solid", fgColor=NAVY)
REQ_FILL = PatternFill("solid", fgColor=GOLD)
PALE_FILL = PatternFill("solid", fgColor=PALE)
THIN = Border(bottom=Side(style="thin", color="DDD3BC"))
TABLE_ROWS = 2000  # rows pre-formatted and validated per sheet

FORMATS = {"date": "DD-MMM-YYYY", "number": "#,##,##0.00", "month": "@"}


def to_cell(col, value):
    if value is None:
        return None
    if col["type"] == "date":
        y, m, d = map(int, value.split("-"))
        return date(y, m, d)
    return value


def instructions_sheet(wb):
    ws = wb.create_sheet("Instructions")
    ws.sheet_view.showGridLines = False
    ws.column_dimensions["A"].width = 3
    ws.column_dimensions["B"].width = 26
    ws.column_dimensions["C"].width = 95
    ws["B2"] = "ASSURA ELEVATE"
    ws["B2"].font = Font(bold=True, color=GOLD, size=11)
    ws["B3"] = "Monthly Data Collection Workbook"
    ws["B3"].font = TITLE_FONT
    ws["B4"] = f"Template version {SCHEMA['version']}. Prepared by your in-house accountant once a month and uploaded to your Assura Elevate login."
    ws["B4"].font = SUB_FONT
    steps = [
        ("1. Company & Period", "Your company, the month and the workbook reference are filled in by Assura Elevate and locked. Add your name and any notes for the month."),
        ("2. One workbook a month", "Each month Assura Elevate sends a fresh copy made for your company and that month only. Use the copy you received for that month; another company's or another month's copy is refused."),
        ("3. Paste from Tally", "Each sheet names the Tally report it comes from. Paste rows under the blue header; extra columns are ignored."),
        ("4. Columns", "Gold headers are required. Keep the header names. Dates can be 01-09-2026, 2026-09-01 or 1-Sep-2026."),
        ("5. Amounts", "Enter amounts in rupees without symbols. Negative balances (OD/CC utilisation) as minus figures."),
        ("6. Month-end positions", "Receivables, Payables, Inventory and Cash & Bank are balances on the last day of the month, bill by bill."),
        ("7. Return it", "Reply to the email with the completed workbook attached. Assura Elevate checks it is your company's copy for the month, reviews it and then adds it to your dashboard."),
        ("Your role", "You remain responsible for the books. Assura Elevate reviews, analyses and reports on the data you provide."),
    ]
    r = 6
    for title, text in steps:
        ws.cell(row=r, column=2, value=title).font = Font(bold=True, color=NAVY)
        c = ws.cell(row=r, column=3, value=text)
        c.alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[r].height = 30
        r += 1
    r += 1
    ws.cell(row=r, column=2, value="Sheet").font = HEAD_FONT
    ws.cell(row=r, column=3, value="What goes in it").font = HEAD_FONT
    for c in (2, 3):
        ws.cell(row=r, column=c).fill = HEAD_FILL
    for sheet in SCHEMA["sheets"]:
        r += 1
        ws.cell(row=r, column=2, value=sheet["name"]).font = Font(bold=True)
        c = ws.cell(row=r, column=3, value=sheet["purpose"])
        c.alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[r].height = 30


def form_sheet(wb, sheet, values=None):
    ws = wb.active
    ws.title = sheet["name"]
    ws.sheet_view.showGridLines = False
    ws.column_dimensions["A"].width = 28
    ws.column_dimensions["B"].width = 34
    ws.column_dimensions["C"].width = 70
    for i, h in enumerate(["Field", "Value", "Guidance"], start=1):
        c = ws.cell(row=1, column=i, value=h)
        c.font = HEAD_FONT
        c.fill = HEAD_FILL
    for i, f in enumerate(sheet["fields"], start=2):
        a = ws.cell(row=i, column=1, value=f["label"])
        a.font = Font(bold=True, color=NAVY if not f["required"] else "000000")
        if f["required"]:
            a.fill = PatternFill("solid", fgColor="F6EBCB")
        if f.get("system"):
            # Filled in by the portal for one company and month; locked for the accountant.
            v = (values or {}).get(f["key"])
            b = ws.cell(row=i, column=2, value=v if v is not None else "{{" + f["key"] + "}}")
            b.fill = PatternFill("solid", fgColor=LOCKED)
            b.font = Font(bold=True, color=NAVY)
            b.number_format = "@"
            b.protection = Protection(locked=True)
        else:
            b = ws.cell(row=i, column=2, value=to_cell(f, (values or {}).get(f["key"])))
            b.fill = PALE_FILL
            b.protection = Protection(locked=False)
            if f["type"] in FORMATS:
                b.number_format = FORMATS[f["type"]]
        b.border = THIN
        ws.cell(row=i, column=3, value=("Required. " if f["required"] and not f.get("system") else "") + f.get("help", "")).font = SUB_FONT
    # Only the locked fields are protected; the rest of the workbook stays open for pasting from Tally.
    ws.protection.sheet = True
    ws.protection.formatCells = False
    ws.protection.formatColumns = False


def table_sheet(wb, sheet, rows=None):
    ws = wb.create_sheet(sheet["name"])
    ws.freeze_panes = "A2"
    for i, col in enumerate(sheet["columns"], start=1):
        c = ws.cell(row=1, column=i, value=col["label"])
        c.font = HEAD_FONT
        c.fill = REQ_FILL if col["required"] else HEAD_FILL
        c.alignment = Alignment(wrap_text=True, vertical="center")
        note = ("Required. " if col["required"] else "Optional. ") + col.get("help", "")
        if col["type"] == "enum":
            note += " Choose: " + " / ".join(col["values"])
        if col.get("aliases"):
            note += " Tally names accepted: " + ", ".join(col["aliases"])
        c.comment = Comment(note.strip(), "Assura Elevate")
        letter = get_column_letter(i)
        ws.column_dimensions[letter].width = max(14, min(32, len(col["label"]) + 6))
        if col["type"] == "enum":
            dv = DataValidation(type="list", formula1='"' + ",".join(col["values"]) + '"', allow_blank=True,
                                showErrorMessage=True, errorTitle="Choose from the list",
                                error="Please pick one of: " + ", ".join(col["values"]))
            ws.add_data_validation(dv)
            dv.add(f"{letter}2:{letter}{TABLE_ROWS}")
        if col["type"] in FORMATS:
            for r in range(2, (len(rows) if rows else 0) + 2):
                ws.cell(row=r, column=i).number_format = FORMATS[col["type"]]
    ws.row_dimensions[1].height = 32
    ws.auto_filter.ref = f"A1:{get_column_letter(len(sheet['columns']))}1"
    for r, rec in enumerate(rows or [], start=2):
        for i, col in enumerate(sheet["columns"], start=1):
            cell = ws.cell(row=r, column=i, value=to_cell(col, rec.get(col["key"])))
            if col["type"] in FORMATS:
                cell.number_format = FORMATS[col["type"]]


def store_shared_strings(path):
    """Rewrites the file with the Company & Period sheet uncompressed, so the portal can fill its placeholders."""
    with zipfile.ZipFile(path) as z:
        items = [(i, z.read(i.filename)) for i in z.infolist()]
    with zipfile.ZipFile(path, "w") as z:
        for info, data in items:
            stored = info.filename == "xl/worksheets/sheet1.xml"  # the "Company & Period" sheet, always first
            z.writestr(info.filename, data, compress_type=zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED)


def build(path, data=None):
    wb = Workbook()
    for sheet in SCHEMA["sheets"]:
        if sheet["layout"] == "form":
            form_sheet(wb, sheet, (data or {}).get(sheet["key"]))
    instructions_sheet(wb)
    for sheet in SCHEMA["sheets"]:
        if sheet["layout"] != "form":
            table_sheet(wb, sheet, (data or {}).get(sheet["key"]))
    wb.active = 0
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    store_shared_strings(path)


def sample_ref(code, period):
    return f"{code}-{period}-SAMPLE"


if __name__ == "__main__":
    out = ROOT / "templates" / "Assura_Elevate_Monthly_Data_Template.xlsx"
    build(out)
    print("template:", out.relative_to(ROOT))
    if "--samples" in sys.argv:
        for f in sorted((ROOT / "samples" / "json").glob("*/*.json")):
            target = ROOT / "samples" / "xlsx" / f.parent.name / (f.stem + ".xlsx")
            data = json.loads(f.read_text())
            # Sample copies carry a fixed reference that the demo and tests record as issued.
            data["company"]["template_ref"] = sample_ref(data["company"]["company_code"], data["company"]["period"])
            build(target, data)
        print("sample workbooks written to samples/xlsx")
