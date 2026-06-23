# dataframe — Pandas-like data analysis for Ezy

CSV-backed DataFrames with aggregations, filtering, sorting and group-by.
A DataFrame is an opaque integer handle (`0` = invalid). Columns keep the
original cell text **and** a parsed numeric view; numeric aggregations skip
empty / non-numeric cells. Transform functions (`head`, `tail`, `select`,
`filter_*`, `sort`, `groupby_*`) return a **new** handle and never mutate the
source.

## Install

```bash
ezyl install dataframe          # or: ezyl install ./dataframe (local)
```

## Example

`people.csv`:

```csv
name,age,city,income
Ana,34,Madrid,42000
Luis,28,Madrid,38000
Marta,45,Sevilla,51000
Juan,52,Sevilla,60000
```

```ezy
import "dataframe"

fn main():
{
    df = df_read_csv("people.csv")
    print("rows:", df_rows(df), "cols:", df_cols(df))
    df_print(df)

    print("mean age:", df_mean(df, "age"))
    print("max income:", df_max(df, "income"))

    adults = df_filter_ge(df, "age", 30.0)
    ranked = df_sort(adults, "income", 0)      # 0 = descending
    df_print(ranked)

    by_city = df_groupby_mean(df, "city", "income")
    df_print(by_city)

    print(df_describe(df))
}
```

## API

### I/O
- `df_read_csv(path) -> int` — parse a CSV file into a handle (`0` on error)
- `df_read_csv_string(text) -> int` — parse inline CSV text
- `df_save_csv(h, path) -> int` — write the frame back to CSV (`1` ok)
- `df_free(h) -> int` — release a handle

### Shape / metadata
- `df_rows(h)`, `df_cols(h)`
- `df_col_name(h, i) -> string`
- `df_has_col(h, name)`, `df_col_index(h, name)` (`-1` if absent)
- `df_is_numeric(h, col)`

### Cell access (column by name)
- `df_get_float(h, row, col) -> float`
- `df_get_int(h, row, col) -> int`
- `df_get_str(h, row, col) -> string`

### Aggregations (numeric column, empties skipped)
- `df_count`, `df_sum`, `df_mean`, `df_min`, `df_max`
- `df_std` (sample, n-1), `df_var`, `df_median`, `df_nunique`

### Selection / transform (return a new handle)
- `df_head(h, n)`, `df_tail(h, n)`
- `df_select(h, "a,b,c")` — subset of columns
- `df_filter_gt/ge/lt/le/eq/ne(h, col, value)` — numeric predicates
- `df_filter_str(h, col, text)` — exact text match
- `df_sort(h, col, ascending)` — `ascending`: `1` asc, `0` desc
- `df_sort_multi(h, cols, asc)` — multi-key sort, e.g. cols `"region,units"`,
  asc `"1,0"` (region ascending, units descending)
- `df_crosstab(h, row_col, col_col)` — co-occurrence count cross-tabulation
- `df_resample(h, date_col, freq, value_col, agg)` — bucket dates into periods
  (`freq` ∈ `D`/`W`/`M`/`Q`/`Y`) and aggregate; sorted chronologically

### Expression eval (the `df.eval` / `assign` substitute)
- `df_eval(h, newcol, expr)` — add a column from an arithmetic expression over
  existing columns: `+ - * / %`, parentheses, numeric literals, unary minus.
  Example: `df_eval(h, "net", "units * price * (1 - 0.1) + 5")`.
  (A general `apply(lambda)` is not possible yet — the language has no closures —
  but `df_eval` covers numeric row-wise transforms.)

### Query / predicates / top-N (return a new handle)
- `df_query(h, expr)` — predicate string, e.g. `"age > 30 and dept == Eng"`
  (clauses `COL OP VALUE` joined by `and`/`or`, no parentheses)
- `df_isin(h, col, "a,b,c")` — value in a set
- `df_between(h, col, lo, hi)` — `lo <= col <= hi`
- `df_str_contains(h, col, sub)` — substring match
- `df_nlargest(h, col, n)` / `df_nsmallest(h, col, n)` — top / bottom n

### De-duplication / replacement / sampling
- `df_drop_duplicates(h, col)` / `df_drop_duplicates_all(h)`
- `df_replace_str(h, col, oldv, newv)`
- `df_sample(h, n)` / `df_set_seed(s)`

### Group-by (group_col → aggregate, new 2-column handle)
- `df_groupby_mean/sum/min/max(h, group_col, value_col)`
- `df_groupby_count(h, group_col)`
- `df_value_counts(h, col)` — distinct values + counts, sorted descending

### Computed columns (new handle with one extra numeric column)
- `df_with_calc(h, newcol, a, oper, b)` — `newcol = a <op> b` elementwise
- `df_with_scalar(h, newcol, col, oper, scalar)` — `newcol = col <op> scalar`
- `oper` is one of `"+"`, `"-"`, `"*"`, `"/"`, `"%"`

### Reshape (new handle)
- `df_rename(h, oldname, newname)`
- `df_drop(h, col)`
- `df_concat(a, b)` — stack rows (same column count)
- `df_merge(left, right, on)` — inner join on a key column
- `df_merge_left(left, right, on)` — left join (keep all left rows)
- `df_merge_outer(left, right, on)` — full outer join (union of keys)

### Multi-aggregate group-by (new handle)
- `df_groupby_agg(h, group_col, value_col, aggs)` — `aggs` is a comma list
  of `mean`, `sum`, `count`, `min`, `max`, `std`, `median`; one column each
- `df_groupby_multi(h, group_cols, value_col, agg)` — group by several key
  columns (`"region,product"`); one aggregate column (`value_col` may be `""`
  for `count`)

### Datetime
Dates are strings in `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS` (also `YYYY/MM/DD`).
Extractors add a numeric column; arithmetic/format add a string column.
- `df_dt_year/month/day/weekday/hour/minute/second/dayofyear/quarter(h, newcol, col)`
  — `weekday` is Monday=0
- `df_dt_diff_days(h, newcol, col_a, col_b)` — `a - b` in whole days
- `df_dt_add_days(h, newcol, col, days)` — shift dates → new `YYYY-MM-DD`
- `df_dt_format(h, newcol, col, fmt)` — `strftime` formatting
- `df_dt_filter_range(h, col, start, end)` — keep rows with date in `[start, end]`
- `df_dt_now() -> string` — current UTC timestamp

### Statistics
- `df_corr(h, a, b)` — Pearson correlation between two numeric columns
- `df_quantile(h, col, q)` — quantile `q ∈ [0,1]`, linear interpolation

### Missing data (new handle)
- `df_dropna(h, col)` — drop rows where the column is empty
- `df_fillna(h, col, value)` — fill empty numeric cells
- `df_fillna_str(h, col, text)` — fill empty cells with text

### Cumulative / rolling / element-wise (add a column, new handle)
- `df_cumsum/cummax/cummin/cumprod(h, col)`
- `df_rolling_mean(h, col, window)` → `<col>_rollN`
- `df_rolling_sum(h, col, window)` → `<col>_rollsumN`
- `df_expanding_mean(h, col)` → `<col>_expmean`
- `df_with_round(h, newcol, col, ndigits)`
- `df_with_abs(h, newcol, col)`
- `df_with_clip(h, newcol, col, lo, hi)`
- `df_rank(h, newcol, col, ascending)` — ordinal rank
- `df_with_str(h, newcol, col, oper)` — `oper` ∈ `upper`/`lower`/`len`/`strip`/`title`
- `df_add_rownum(h, name)` — add a 0-based index column

### Reshape extras (new handle)
- `df_unique(h, col)` — distinct values as a one-column frame
- `df_pivot(h, index_col, columns_col, value_col, agg)` — long → wide pivot;
  `agg` ∈ `"mean"`, `"sum"`, `"count"`, `"min"`, `"max"`
- `df_melt(h, id_cols, value_cols, var_name, value_name)` — wide → long
- `df_shape(h) -> string` — `"(rows, cols)"`

### Rendering
- `df_print(h)` — pretty table to stdout (first 20 rows)
- `df_to_string(h) -> string` — full table as text
- `df_describe(h) -> string` — count/mean/std/min/max per numeric column
- `df_describe_str(h) -> string` — count/unique/top/freq per string column

### Export
- `df_to_markdown(h) -> string` — GitHub-flavored markdown table
- `df_to_json(h) -> string` — array of objects (numbers/null typed, strings quoted)
- `df_save_markdown(h, path) -> int`
- `df_save_json(h, path) -> int`

## Notes

- CSV parsing handles quoted fields and `""` escapes; the first row is the header.
- A column is treated as numeric only when every non-empty cell parses as a number.
- Strings returned across the boundary are owned by the library.
