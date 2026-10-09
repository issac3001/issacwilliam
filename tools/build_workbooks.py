#!/usr/bin/env python3
"""Builds the monthly data collection workbook from shared/schema.json.

  python3 tools/build_workbooks.py            -> templates/Assura_Elevate_Monthly_Data_Template.xlsx
  python3 tools/build_workbooks.py --samples  -> also samples/xlsx/<code>/<period>.xlsx from samples/json
"""
import json
import sys
from datetime import date
from pathlib import Path

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = json.loads((ROOT / "shared" / "schema.json").read_text())

NAVY = "1F3A68"
GOLD = "E0A708"
PALE = "EEF2F8"
HEAD_FONT = Font(name="Calibri", bold=True, color="FFFFFF", size=11)
TITLE_FONT = Font(name="Calibri", bold=True, color=NAVY, size=16)
SUB_FONT = Font(name="Calibri", italic=True, color="5A6475", size=10)
HEAD_FILL = PatternFill("solid", fgColor=NAVY)
REQ_FILL = PatternFill("solid", fgColor=GOLD)
PALE_FILL = PatternFill("solid", fgColor=PALE)
THIN = Border(bottom=Side(style="thin", color="D5DBE5"))
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
    ws = wb.active
    ws.title = "Instructions"
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
        ("1. Company & Period", "Fill your company code (issued by Assura Elevate), the month, and your name."),
        ("2. One workbook a month", "Use a fresh copy each month. Uploading the same month again replaces the earlier version, and the history is kept."),
        ("3. Paste from Tally", "Each sheet names the Tally report it comes from. Paste rows under the blue header; extra columns are ignored."),
        ("4. Columns", "Gold headers are required. Keep the header names. Dates can be 01-09-2026, 2026-09-01 or 1-Sep-2026."),
        ("5. Amounts", "Enter amounts in rupees without symbols. Negative balances (OD/CC utilisation) as minus figures."),
        ("6. Month-end positions", "Receivables, Payables, Inventory and Cash & Bank are balances on the last day of the month, bill by bill."),
        ("7. Upload", "Sign in, open Upload data, choose this file. The platform checks it and lists anything that needs fixing before it is accepted."),
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
    ws = wb.create_sheet(sheet["name"])
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
        b = ws.cell(row=i, column=2, value=to_cell(f, (values or {}).get(f["key"])))
        b.fill = PALE_FILL
        b.border = THIN
        if f["type"] in FORMATS:
            b.number_format = FORMATS[f["type"]]
        ws.cell(row=i, column=3, value=("Required. " if f["required"] else "") + f.get("help", "")).font = SUB_FONT


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


def build(path, data=None):
    wb = Workbook()
    instructions_sheet(wb)
    for sheet in SCHEMA["sheets"]:
        if sheet["layout"] == "form":
            form_sheet(wb, sheet, (data or {}).get(sheet["key"]))
        else:
            table_sheet(wb, sheet, (data or {}).get(sheet["key"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)


if __name__ == "__main__":
    out = ROOT / "templates" / "Assura_Elevate_Monthly_Data_Template.xlsx"
    build(out)
    print("template:", out.relative_to(ROOT))
    if "--samples" in sys.argv:
        for f in sorted((ROOT / "samples" / "json").glob("*/*.json")):
            target = ROOT / "samples" / "xlsx" / f.parent.name / (f.stem + ".xlsx")
            build(target, json.loads(f.read_text()))
        print("sample workbooks written to samples/xlsx")
