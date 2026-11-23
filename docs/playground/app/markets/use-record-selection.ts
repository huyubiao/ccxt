import { useState } from "react";

export function useRecordSelection<Row>(records: readonly Row[], keyOf: (row: Row) => string, {
  label, canDelete, onDelete, confirmation = "",
}: {
  label: string;
  canDelete: boolean;
  onDelete: (records: readonly Row[]) => Promise<void>;
  confirmation?: string;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [deletedCount, setDeletedCount] = useState(0);
  const chosen = records.filter((row) => selected.has(keyOf(row)));
  const allSelected = records.length > 0 && chosen.length === records.length;
  const partlySelected = chosen.length > 0 && !allSelected;

  function select(key: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function selectAll(checked: boolean) {
    setSelected(new Set(checked ? records.map(keyOf) : []));
  }

  async function deleteSelected() {
    if (!canDelete || deleting || !chosen.length || !window.confirm(`确定删除选中的 ${chosen.length} 条${label}？${confirmation}`)) return;
    setDeleting(true);
    setError("");
    setDeletedCount(0);
    try {
      await onDelete(chosen);
      setSelected(new Set());
      setDeletedCount(chosen.length);
    } catch (error) {
      setError(error instanceof Error ? error.message : `无法删除${label}。`);
    } finally {
      setDeleting(false);
    }
  }

  return { selected, count: chosen.length, allSelected, partlySelected, deleting, error, deletedCount,
    select, selectAll, deleteSelected };
}
