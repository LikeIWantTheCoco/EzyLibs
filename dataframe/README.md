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

### Statistics
- `df_corr(h, a, b)` — Pearson correlation between two numeric columns
- `df_quantile(h, col, q)` — quantile `q ∈ [0,1]`, linear interpolation

### Missing data (new handle)
- `df_dropna(h, col)` — drop rows where the column is empty
- `df_fillna(h, col, value)` — fill empty numeric cells
- `df_fillna_str(h, col, text)` — fill empty cells with text

### Cumulative / rolling / element-wise (add a column, new handle)
- `df_cumsum(h, col)` → adds `<col>_cumsum`
- `df_rolling_mean(h, col, window)` → adds `<col>_rollN`
- `df_with_round(h, newcol, col, ndigits)`
- `df_with_abs(h, newcol, col)`
- `df_with_clip(h, newcol, col, lo, hi)`
- `df_rank(h, newcol, col, ascending)` — ordinal rank

### Reshape extras (new handle)
- `df_unique(h, col)` — distinct values as a one-column frame
- `df_pivot(h, index_col, columns_col, value_col, agg)` — pivot table;
  `agg` ∈ `"mean"`, `"sum"`, `"count"`, `"min"`, `"max"`

### Rendering
- `df_print(h)` — pretty table to stdout (first 20 rows)
- `df_to_string(h) -> string` — full table as text
- `df_describe(h) -> string` — count/mean/std/min/max per numeric column

## Notes

- CSV parsing handles quoted fields and `""` escapes; the first row is the header.
- A column is treated as numeric only when every non-empty cell parses as a number.
- Strings returned across the boundary are owned by the library.
