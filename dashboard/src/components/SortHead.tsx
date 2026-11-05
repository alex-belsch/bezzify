export interface Sort<K extends string = string> {
  key: K;
  dir: 1 | -1;
}

export function SortHead<K extends string>({ id, label, sort, setSort }: { id: K; label: string; sort: Sort<K>; setSort: (sort: Sort<K>) => void }) {
  const active = sort.key === id;
  return (
    <th className="sortable" aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => setSort({ key: id, dir: active ? (sort.dir === 1 ? -1 : 1) : -1 })}>
        {label}
        {active && <span aria-hidden="true">{sort.dir === 1 ? ' ▲' : ' ▼'}</span>}
      </button>
    </th>
  );
}

export function sortRows<T extends object>(rows: T[], sort: Sort): T[] {
  const valueOf = (row: T) => (row as Record<string, unknown>)[sort.key];
  return [...rows].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb), 'de') * sort.dir;
    return (Number(va ?? -Infinity) - Number(vb ?? -Infinity)) * sort.dir;
  });
}
