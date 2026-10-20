"""Parses the labour source files into labour_actuals rows.

  - sample_hours_2023.xlsx              'Raw Data'  -> vintage 2023
  - sample_hours_2024.xlsx              'Raw Data'  -> vintage 2024
  - sample_invoice_backup_2026_07.xlsx  'Labor'     -> vintage 2026 (July)
  - sample_invoice_backup_2026_07.xlsx  'Expenses'  -> vintage 2026 (July)
  - sample_invoice_backup_2026_08.xlsx  'Labor'     -> vintage 2026 (August)
  - sample_invoice_backup_2026_08.xlsx  'Expenses'  -> vintage 2026 (August)

The files in seed-data/labour_raw/ are made-up samples (ten rows per sheet)
in the same layout as the real source files, which are not in this
repository. The real files' invoice numbers and totals are not here either.

Every parse function returns (rows, checksum). checksum compares computed
totals against CHECKSUMS below, which are the sample files' own totals.
backfill.py refuses to insert a source whose checksum doesn't reconcile.
"""

from __future__ import annotations

import re
from pathlib import Path

import openpyxl
import pandas as pd

RAW_DIR = Path(__file__).parent.parent.parent / "seed-data" / "labour_raw"

_CODE_RE = re.compile(r"^(\d+(?:\.\d+)?)\s+(.*)$")

# Expense account -> folded job_category. Strips the leading account
# number and maps by name -- 'Toilet, Other' is a genuinely new category
# ('Other'), not folded into an existing labor category.
ACCOUNT_CATEGORY_MAP = {
    "Fertilize": "Fertilize",
    "Disease Control": "Disease Control",
    "Irrigation": "Irrigation",
    "Toilet, Other": "Other",
}

CHECKSUMS = {'2023': {'rows': 10, 'hours': 101.5, 'amount': 4938.0, 'job_categories': 5, 'invoices': 4},
 '2024': {'rows': 10,
          'hours': 102.75,
          'amount': 5012.5,
          'job_categories': 6,
          'farming_hours': 60.0,
          'farming_amount': 2930.0,
          'development_hours': 42.75,
          'development_amount': 2082.5},
 'mars_invoice_labor': {'rows': 10,
                        'hours': 124.25,
                        'amount': 5357.5,
                        'job_categories': 6,
                        'development_hours': 75.0,
                        'development_amount': 3086.0,
                        'farming_hours': 49.25,
                        'farming_amount': 2271.5},
 'mars_invoice_expenses': {'rows': 10,
                           'amount': 5545.14,
                           'by_category': {'Fertilize': 1703.51,
                                           'Harvest': 1034.76,
                                           'Irrigation': 807.53,
                                           'Other': 828.46,
                                           'Disease Control': 1170.88}},
 'mars_invoice_labor_aug': {'rows': 10,
                            'hours': 121.75,
                            'amount': 5977.5,
                            'job_categories': 5,
                            'development_hours': 50.25,
                            'development_amount': 2210.5,
                            'farming_hours': 71.5,
                            'farming_amount': 3767.0},
 'mars_invoice_expenses_aug': {'rows': 10,
                               'amount': 3671.83,
                               'by_category': {'Harvest': 741.01,
                                               'Fertilize': 1264.4,
                                               'Disease Control': 232.46,
                                               'Irrigation': 1125.77,
                                               'Other': 308.19}}}
_TOL = 0.01


def _split_code(raw: str) -> tuple[str | None, str]:
    """'028.00 General Labor' -> ('028.00', 'General Labor'); no code prefix -> (None, raw)."""
    m = _CODE_RE.match(raw.strip())
    return (m.group(1), m.group(2)) if m else (None, raw.strip())


def _month_start(month_name: str, year: int) -> str:
    return pd.Timestamp(f"{month_name} 1, {year}").date().isoformat()


def parse_2023(path: Path = RAW_DIR / "sample_hours_2023.xlsx") -> tuple[list[dict], dict]:
    df = pd.read_excel(path, sheet_name="Raw Data")
    df = df[df["Month"].notna()].reset_index(drop=True)

    rows = []
    for i, r in df.iterrows():
        task_code, task = _split_code(str(r["Task"]))
        role_code, role = _split_code(str(r["Role"]))
        rows.append({
            "vintage": 2023,
            "period_month": _month_start(r["Month"], 2023),
            "invoice_number": str(int(r["Invoice #"])),
            "invoice_type": None,
            "job_category": r["Job Category"],
            "task": task, "task_code": task_code,
            "role": role, "role_code": role_code,
            "hours": float(r["Hours"]), "rate_per_hour": float(r["Rate ($/hr)"]),
            "amount_usd": float(r["Amount ($)"]),
            "entry_kind": "labor",
            "expense_vendor": None, "expense_memo": None, "expense_account": None, "expense_date": None,
            "source_system": "silverado_hours_analysis",
            "source_file": "sample_hours_2023.xlsx",
            "source_row_id": i + 2,  # +2: 1-based, plus header row
        })

    c = CHECKSUMS["2023"]
    check = {
        "label": "2023 Raw Data",
        "checks": [
            ("rows", len(rows), c["rows"]),
            ("hours", sum(r["hours"] for r in rows), c["hours"]),
            ("amount", sum(r["amount_usd"] for r in rows), c["amount"]),
            ("job_categories", df["Job Category"].nunique(), c["job_categories"]),
            ("invoices", df["Invoice #"].nunique(), c["invoices"]),
        ],
    }
    return rows, check


def parse_2024(path: Path = RAW_DIR / "sample_hours_2024.xlsx") -> tuple[list[dict], dict]:
    df = pd.read_excel(path, sheet_name="Raw Data")
    df = df[df["Month"].notna()].reset_index(drop=True)

    rows = []
    for i, r in df.iterrows():
        task_code, task = _split_code(str(r["Task"]))
        role_code, role = _split_code(str(r["Role"]))
        rows.append({
            "vintage": 2024,
            "period_month": _month_start(r["Month"], 2024),
            "invoice_number": str(int(r["Invoice #"])),
            "invoice_type": r["Invoice Type"],
            "job_category": r["Job Category"],
            "task": task, "task_code": task_code,
            "role": role, "role_code": role_code,
            "hours": float(r["Hours"]), "rate_per_hour": float(r["Rate ($/hr)"]),
            "amount_usd": float(r["Amount ($)"]),
            "entry_kind": "labor",
            "expense_vendor": None, "expense_memo": None, "expense_account": None, "expense_date": None,
            "source_system": "silverado_hours_analysis",
            "source_file": "sample_hours_2024.xlsx",
            "source_row_id": i + 2,
        })

    c = CHECKSUMS["2024"]
    farming = df[df["Invoice Type"] == "Farming"]
    development = df[df["Invoice Type"] == "Development"]
    check = {
        "label": "2024 Raw Data",
        "checks": [
            ("rows", len(rows), c["rows"]),
            ("hours", sum(r["hours"] for r in rows), c["hours"]),
            ("amount", sum(r["amount_usd"] for r in rows), c["amount"]),
            ("job_categories", df["Job Category"].nunique(), c["job_categories"]),
            ("farming_hours", farming["Hours"].sum(), c["farming_hours"]),
            ("farming_amount", farming["Amount ($)"].sum(), c["farming_amount"]),
            ("development_hours", development["Hours"].sum(), c["development_hours"]),
            ("development_amount", development["Amount ($)"].sum(), c["development_amount"]),
        ],
    }
    return rows, check


def parse_mars_invoice_labor(
    path: Path = RAW_DIR / "sample_invoice_backup_2026_07.xlsx",
    *,
    period_month: str = "2026-07-01",
    # One invoice number per division; the Labor tab itself has none.
    invoice_by_division: dict[str, str] | None = None,
    checksum_key: str = "mars_invoice_labor",
) -> tuple[list[dict], dict]:
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["Labor"]

    invoice_by_division = invoice_by_division or {"Mars Development": "10001", "Mars Farming": "10002"}
    source_file = f"{path.name}:Labor"

    rows = []
    division = None
    for r in range(2, ws.max_row + 1):
        b, c_ = ws.cell(r, 2).value, ws.cell(r, 3).value
        d, e, f = ws.cell(r, 4).value, ws.cell(r, 5).value, ws.cell(r, 6).value
        a = ws.cell(r, 1).value
        if a == "TOTAL":
            continue
        if b is not None:
            if isinstance(b, str) and b.startswith("Total "):
                continue
            division = b.split(":")[-1]  # 'Example Estates Inc.:Mars Development' -> 'Mars Development'
            continue
        if c_ is None or ":" not in str(c_):
            continue
        job_category, task_raw, role_raw = str(c_).split(":", 2)
        task_code, task = _split_code(task_raw)
        role_code, role = _split_code(role_raw)
        rows.append({
            "vintage": 2026,
            "period_month": period_month,
            "invoice_number": invoice_by_division[division],
            "invoice_type": division,
            "job_category": job_category,
            "task": task, "task_code": task_code,
            "role": role, "role_code": role_code,
            "hours": float(d), "rate_per_hour": float(e),
            "amount_usd": float(f),
            "entry_kind": "labor",
            "expense_vendor": None, "expense_memo": None, "expense_account": None, "expense_date": None,
            "source_system": "mars_invoice_labor",
            "source_file": source_file,
            "source_row_id": r,
        })

    c = CHECKSUMS[checksum_key]
    dev = [r for r in rows if r["invoice_type"] == "Mars Development"]
    farm = [r for r in rows if r["invoice_type"] == "Mars Farming"]
    check = {
        "label": f"Mars Invoice Backup ({path.name}): Labor",
        "checks": [
            ("rows", len(rows), c["rows"]),
            ("hours", sum(r["hours"] for r in rows), c["hours"]),
            ("amount", sum(r["amount_usd"] for r in rows), c["amount"]),
            ("job_categories", len({r["job_category"] for r in rows}), c["job_categories"]),
            ("development_hours", sum(r["hours"] for r in dev), c["development_hours"]),
            ("development_amount", sum(r["amount_usd"] for r in dev), c["development_amount"]),
            ("farming_hours", sum(r["hours"] for r in farm), c["farming_hours"]),
            ("farming_amount", sum(r["amount_usd"] for r in farm), c["farming_amount"]),
        ],
    }
    return rows, check


def parse_mars_invoice_expenses(
    path: Path = RAW_DIR / "sample_invoice_backup_2026_07.xlsx",
    *,
    checksum_key: str = "mars_invoice_expenses",
) -> tuple[list[dict], dict]:
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["Expenses"]
    source_file = f"{path.name}:Expenses"

    rows = []
    division = None
    for r in range(2, ws.max_row + 1):  # row 1 is the header
        a = ws.cell(r, 1).value
        c_ = ws.cell(r, 3).value
        dtype = ws.cell(r, 4).value
        if a == "TOTAL":
            continue
        if c_ is not None:
            if isinstance(c_, str) and c_.startswith("Total "):
                continue
            division = c_  # 'Mars Development' / 'Mars Farming'
            continue
        if dtype is None:
            continue
        date_val = ws.cell(r, 5).value
        source_name = ws.cell(r, 6).value
        memo = ws.cell(r, 7).value
        account = ws.cell(r, 8).value
        amount = ws.cell(r, 9).value
        account_name = account.split("·")[-1].strip() if account else None
        job_category = ACCOUNT_CATEGORY_MAP.get(account_name, account_name)
        rows.append({
            "vintage": 2026,
            "period_month": date_val.replace(day=1).date().isoformat(),
            "invoice_number": None,
            "invoice_type": division,
            "job_category": job_category,
            "task": None, "task_code": None, "role": None, "role_code": None,
            "hours": None, "rate_per_hour": None,
            "amount_usd": float(amount),
            "entry_kind": "expense",
            "expense_vendor": source_name, "expense_memo": memo,
            "expense_account": account, "expense_date": date_val.date().isoformat(),
            "source_system": "mars_invoice_expense",
            "source_file": source_file,
            "source_row_id": r,
        })

    c = CHECKSUMS[checksum_key]
    by_cat: dict[str, float] = {}
    for r in rows:
        by_cat[r["job_category"]] = by_cat.get(r["job_category"], 0.0) + r["amount_usd"]

    checks = [
        ("rows", len(rows), c["rows"]),
        ("amount", sum(r["amount_usd"] for r in rows), c["amount"]),
    ]
    for cat, target in c["by_category"].items():
        checks.append((f"category:{cat}", by_cat.get(cat, 0.0), target))

    return rows, {"label": f"Mars Invoice Backup ({path.name}): Expenses", "checks": checks}


# August 2026 -- same file format as July (same two tabs, same colon-delimited
# activity format, same expense account set plus one new account, '6018 ·
# Harvest', which is not in ACCOUNT_CATEGORY_MAP but needs no new mapping
# entry: 'Harvest' already exists as a real job_category on the Labor side,
# so ACCOUNT_CATEGORY_MAP.get('Harvest', 'Harvest') correctly folds it in via
# the existing pass-through default rather than dropping or mis-mapping it.
def parse_mars_invoice_labor_aug(path: Path = RAW_DIR / "sample_invoice_backup_2026_08.xlsx") -> tuple[list[dict], dict]:
    return parse_mars_invoice_labor(
        path,
        period_month="2026-08-01",
        invoice_by_division={"Mars Development": "10003", "Mars Farming": "10004"},
        checksum_key="mars_invoice_labor_aug",
    )


def parse_mars_invoice_expenses_aug(path: Path = RAW_DIR / "sample_invoice_backup_2026_08.xlsx") -> tuple[list[dict], dict]:
    return parse_mars_invoice_expenses(path, checksum_key="mars_invoice_expenses_aug")


def evaluate(check: dict) -> bool:
    """Prints every check line and returns True iff all reconcile within tolerance."""
    ok = True
    print(f"  self-check ({check['label']}, vs. verified source-file checksums):")
    for name, computed, target in check["checks"]:
        diff = computed - target
        passed = abs(diff) <= _TOL
        ok = ok and passed
        print(f"    {name}: computed={computed}, target={target}, diff={diff:+.4f}  [{'OK' if passed else 'FAIL'}]")
    for flag in check.get("flags", []):
        print(f"  FLAG (non-blocking): {flag}")
    return ok
