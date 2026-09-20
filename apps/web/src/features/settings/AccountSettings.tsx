import { useState } from 'react';
import { api } from '../../lib/api';
import { browserAnalyticsEnabled, setBrowserAnalyticsEnabled } from '../../lib/telemetry';
import { ConversationPrivacy } from './ConversationPrivacy';

export function AccountSettings() {
  const [analytics, setAnalytics] = useState(browserAnalyticsEnabled);
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState<'export' | 'delete' | null>(null);
  const [error, setError] = useState('');
  async function exportData() {
    setPending('export');
    setError('');
    try {
      const data = await api.exportAccount();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'walden-export.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not export your data.');
    } finally {
      setPending(null);
    }
  }
  async function deleteAccount() {
    if (confirmation !== 'DELETE' || pending) return;
    setPending('delete');
    setError('');
    try {
      await api.deleteAccount();
      for (const storage of [localStorage, sessionStorage])
        for (const key of Object.keys(storage))
          if (key.startsWith('walden:')) storage.removeItem(key);
      location.assign('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete your account.');
      setPending(null);
    }
  }
  return (
    <section>
      <h2>Account</h2>
      <ConversationPrivacy />
      <div className="settings-row">
        <div>
          <h3>Browser analytics</h3>
          <p>
            Share page visits and feature usage to help improve Walden. This browser preference does
            not affect server diagnostics.
          </p>
        </div>
        <input
          type="checkbox"
          aria-label="Share browser analytics"
          checked={analytics}
          onChange={(event) => {
            try {
              setBrowserAnalyticsEnabled(event.target.checked);
              setAnalytics(event.target.checked);
              setError('');
            } catch {
              setError('Your browser could not save this preference.');
            }
          }}
        />
      </div>
      <div className="settings-row">
        <div>
          <h3>Export your data</h3>
          <p>Download your notes, personas, and available thread history.</p>
        </div>
        <button disabled={pending !== null} onClick={() => void exportData()}>
          {pending === 'export' ? 'Exporting…' : 'Export data'}
        </button>
      </div>
      <div className="settings-row">
        <div>
          <h3>Delete account</h3>
          <p>Permanently delete your account, notes, personas, and thread history.</p>
        </div>
        <button className="danger" disabled={pending !== null} onClick={() => setConfirming(true)}>
          Delete account
        </button>
      </div>
      {confirming && (
        <div className="notice">
          <p>This cannot be undone. Export anything you want to keep first.</p>
          <label htmlFor="delete-account-confirmation">Type DELETE to confirm</label>
          <input
            id="delete-account-confirmation"
            value={confirmation}
            disabled={pending !== null}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
          />
          <div className="button-row">
            <button
              disabled={pending !== null}
              onClick={() => {
                setConfirming(false);
                setConfirmation('');
              }}
            >
              Cancel
            </button>
            <button
              className="danger"
              disabled={confirmation !== 'DELETE' || pending !== null}
              onClick={() => void deleteAccount()}
            >
              {pending === 'delete' ? 'Deleting…' : 'Permanently delete account'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <p className="muted">
        Thread history expires seven days after your last message. Notes remain until you delete
        them.
      </p>
      <div className="legal-links">
        <a href="/privacy" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        <a href="/terms" target="_blank" rel="noreferrer">
          Terms of Service
        </a>
      </div>
    </section>
  );
}
