import { useState } from 'react';
import { api } from '../../lib/api';

type PendingAction = 'export' | 'delete' | null;

function clearWaldenBrowserState() {
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (key.startsWith('walden:')) storage.removeItem(key);
    }
  }
}

function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useAccountActions() {
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState('');
  const run = async (action: Exclude<PendingAction, null>, work: () => Promise<void>) => {
    setPending(action);
    setError('');
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : action === 'export'
            ? 'Could not export your data.'
            : 'Could not delete your account.',
      );
    } finally {
      setPending(null);
    }
  };
  return {
    pending,
    error,
    setError,
    exportData: () =>
      run('export', async () => downloadJson(await api.exportAccount(), 'walden-export.json')),
    deleteAccount: () =>
      run('delete', async () => {
        await api.deleteAccount();
        clearWaldenBrowserState();
        location.assign('/');
      }),
  };
}
