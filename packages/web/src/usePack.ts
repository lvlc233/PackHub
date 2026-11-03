import { useCallback, useEffect, useState } from 'react';
import { api, type InstallOutcome, type PackDetail, type PackSummary } from './api.ts';

export interface PackState {
  packs: PackSummary[];
  root: string;
  selected: string | null;
  setSelected: (dir: string) => void;
  detail: PackDetail | null;
  /** 上一次安装落在磁盘上的结果（用于打开面板时回填） */
  lastOutcomes: InstallOutcome[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePack(): PackState {
  const [packs, setPacks] = useState<PackSummary[]>([]);
  const [root, setRoot] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PackDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPacks = useCallback(async () => {
    const res = await api.packs();
    setRoot(res.root);
    setPacks(res.packs);
    setSelected((cur) => cur ?? res.packs[0]?.dir ?? null);
  }, []);

  useEffect(() => {
    loadPacks()
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [loadPacks]);

  useEffect(() => {
    if (!selected) return;
    setDetail(null);
    api
      .pack(selected)
      .then(setDetail)
      .catch((err: Error) => setError(err.message));
  }, [selected]);

  const refresh = useCallback(async () => {
    await loadPacks();
    setSelected((cur) => cur);
    if (selected) setDetail(await api.pack(selected));
  }, [loadPacks, selected]);

  const lastOutcomes = (() => {
    if (!detail?.manifest) return null;
    const key = `${detail.manifest.metadata.name}@${detail.manifest.metadata.version}`;
    const actions = detail.state?.[key]?.actions;
    return Array.isArray(actions) ? actions : null;
  })();

  return { packs, root, selected, setSelected, detail, lastOutcomes, loading, error, refresh };
}
