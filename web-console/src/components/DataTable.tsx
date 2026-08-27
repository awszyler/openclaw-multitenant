// ============================================================
// DataTable Component — Generic data table with sort, pagination, search
// Validates: Requirements 9.2
// ============================================================

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronUp, ChevronDown, ChevronsUpDown, Search } from 'lucide-react';

// ---- Types ----

export interface Column<T> {
  /** Unique key for the column, used as the sort key */
  key: string;
  /** Display header */
  header: string;
  /** Render cell content */
  render: (row: T) => React.ReactNode;
  /** Whether this column is sortable (default: false) */
  sortable?: boolean;
  /** Custom sort comparator. If not provided, uses default string comparison on the key. */
  sortFn?: (a: T, b: T) => number;
  /** Optional CSS class for the column */
  className?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  /** Unique key extractor for each row */
  rowKey: (row: T) => string;
  /** Enable search bar */
  searchable?: boolean;
  /** Placeholder for search input */
  searchPlaceholder?: string;
  /** Custom search filter function */
  searchFilter?: (row: T, query: string) => boolean;
  /** Page size options */
  pageSizeOptions?: number[];
  /** Default page size */
  defaultPageSize?: number;
  /** Whether rows are selectable (checkbox column) */
  selectable?: boolean;
  /** Callback when selection changes */
  onSelectionChange?: (selectedKeys: string[]) => void;
  /** Loading state */
  loading?: boolean;
  /** Extra content rendered above the table (e.g. filter dropdowns) */
  toolbar?: React.ReactNode;
}

type SortDirection = 'asc' | 'desc';

interface SortState {
  key: string;
  direction: SortDirection;
}

export default function DataTable<T>({
  columns,
  data,
  rowKey,
  searchable = false,
  searchPlaceholder,
  searchFilter,
  pageSizeOptions = [10, 20, 50],
  defaultPageSize = 10,
  selectable = false,
  onSelectionChange,
  loading = false,
  toolbar,
}: DataTableProps<T>) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  // ---- Filtering ----
  const filtered = useMemo(() => {
    if (!searchable || !search.trim()) return data;
    const q = search.trim().toLowerCase();
    if (searchFilter) return data.filter((row) => searchFilter(row, q));
    // Default: stringify each row and check inclusion
    return data.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
  }, [data, search, searchable, searchFilter]);

  // ---- Sorting ----
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return filtered;

    const arr = [...filtered];
    arr.sort((a, b) => {
      let cmp: number;
      if (col.sortFn) {
        cmp = col.sortFn(a, b);
      } else {
        const aVal = String((a as Record<string, unknown>)[sort.key] ?? '');
        const bVal = String((b as Record<string, unknown>)[sort.key] ?? '');
        cmp = aVal.localeCompare(bVal);
      }
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sort, columns]);

  // ---- Pagination ----
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const paged = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  // ---- Handlers ----
  const handleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key === key) {
        return prev.direction === 'asc' ? { key, direction: 'desc' } : null;
      }
      return { key, direction: 'asc' };
    });
  };

  const toggleSelect = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onSelectionChange?.(Array.from(next));
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedKeys.size === paged.length) {
      setSelectedKeys(new Set());
      onSelectionChange?.([]);
    } else {
      const keys = new Set(paged.map(rowKey));
      setSelectedKeys(keys);
      onSelectionChange?.(Array.from(keys));
    }
  };

  const handlePageSizeChange = (newSize: number) => {
    setPageSize(newSize);
    setPage(0);
  };

  // ---- Sort icon ----
  const SortIcon = ({ columnKey }: { columnKey: string }) => {
    if (sort?.key !== columnKey) return <ChevronsUpDown size={14} className="text-gray-400" />;
    return sort.direction === 'asc' ? (
      <ChevronUp size={14} className="text-blue-600" />
    ) : (
      <ChevronDown size={14} className="text-blue-600" />
    );
  };

  return (
    <div className="space-y-4">
      {/* Toolbar row */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        {searchable && (
          <div className="relative w-full sm:w-72">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder={searchPlaceholder ?? t('common.search')}
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        )}
        {toolbar}
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                {selectable && (
                  <th className="w-10 px-3 py-3">
                    <input
                      type="checkbox"
                      checked={paged.length > 0 && selectedKeys.size === paged.length}
                      onChange={toggleSelectAll}
                      className="rounded border-gray-300"
                      aria-label="Select all rows"
                    />
                  </th>
                )}
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={`px-4 py-3 text-left font-medium text-gray-600 whitespace-nowrap ${col.className ?? ''} ${col.sortable ? 'cursor-pointer select-none hover:text-gray-900' : ''}`}
                    onClick={col.sortable ? () => handleSort(col.key) : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.header}
                      {col.sortable && <SortIcon columnKey={col.key} />}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={columns.length + (selectable ? 1 : 0)} className="px-4 py-12 text-center text-gray-500">
                    {t('common.loading')}
                  </td>
                </tr>
              ) : paged.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + (selectable ? 1 : 0)} className="px-4 py-12 text-center text-gray-500">
                    {t('common.noData')}
                  </td>
                </tr>
              ) : (
                paged.map((row) => {
                  const key = rowKey(row);
                  return (
                    <tr key={key} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                      {selectable && (
                        <td className="w-10 px-3 py-3">
                          <input
                            type="checkbox"
                            checked={selectedKeys.has(key)}
                            onChange={() => toggleSelect(key)}
                            className="rounded border-gray-300"
                            aria-label={`Select row ${key}`}
                          />
                        </td>
                      )}
                      {columns.map((col) => (
                        <td key={col.key} className={`px-4 py-3 ${col.className ?? ''}`}>
                          {col.render(row)}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination footer */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-gray-200 bg-gray-50 text-sm">
          <div className="flex items-center gap-2 text-gray-600">
            <span>{t('common.rowsPerPage')}</span>
            <select
              value={pageSize}
              onChange={(e) => handlePageSizeChange(Number(e.target.value))}
              className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {pageSizeOptions.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
            <span className="text-gray-500">
              {t('common.total', { count: sorted.length })}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t('common.previous')}
            </button>
            <span className="text-gray-600">
              {safePage + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage >= totalPages - 1}
              className="px-3 py-1 border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
