import { useState } from 'react';
import { browserAnalyticsEnabled, setBrowserAnalyticsEnabled } from '../../lib/telemetry';
import { ConversationPrivacy } from './ConversationPrivacy';
import { useAccountActions } from './useAccountActions';

export function AccountSettings() {
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const actions = useAccountActions();
  const closeConfirmation = () => {
    setConfirming(false);
    setConfirmation('');
  };
  return (
    <section>
      <h2>Account</h2>
      <p className="account-retention-note">
        Thread history expires seven days after your last message. Notes remain until you delete
        them.
      </p>
      <ConversationPrivacy />
      <AnalyticsPreference onError={actions.setError} />
      <AccountDataActions
        pending={actions.pending}
        onExport={() => void actions.exportData()}
        onDelete={() => setConfirming(true)}
      />
      {confirming && (
        <DeleteConfirmation
          value={confirmation}
          pending={actions.pending}
          onChange={setConfirmation}
          onCancel={closeConfirmation}
          onDelete={() => void actions.deleteAccount()}
        />
      )}
      {actions.error && (
        <p role="alert" className="inline-error">
          {actions.error}
        </p>
      )}
      <LegalLinks />
    </section>
  );
}

function AnalyticsPreference({ onError }: { onError(value: string): void }) {
  const [enabled, setEnabled] = useState(browserAnalyticsEnabled);
  return (
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
        checked={enabled}
        onChange={(event) => {
          try {
            setBrowserAnalyticsEnabled(event.target.checked);
            setEnabled(event.target.checked);
            onError('');
          } catch {
            onError('Your browser could not save this preference.');
          }
        }}
      />
    </div>
  );
}

function AccountDataActions({
  pending,
  onExport,
  onDelete,
}: {
  pending: 'export' | 'delete' | null;
  onExport(): void;
  onDelete(): void;
}) {
  const busy = pending !== null;
  return (
    <>
      <div className="settings-row">
        <div>
          <h3>Export your data</h3>
          <p>Download your notes, personas, and available thread history.</p>
        </div>
        <button disabled={busy} onClick={onExport}>
          {pending === 'export' ? 'Exporting…' : 'Export data'}
        </button>
      </div>
      <div className="settings-row">
        <div>
          <h3>Delete account</h3>
          <p>Permanently delete your account, notes, personas, and thread history.</p>
        </div>
        <button className="danger" disabled={busy} onClick={onDelete}>
          Delete account
        </button>
      </div>
    </>
  );
}

function DeleteConfirmation({
  value,
  pending,
  onChange,
  onCancel,
  onDelete,
}: {
  value: string;
  pending: 'export' | 'delete' | null;
  onChange(value: string): void;
  onCancel(): void;
  onDelete(): void;
}) {
  const busy = pending !== null;
  return (
    <div className="notice">
      <p>This cannot be undone. Export anything you want to keep first.</p>
      <label htmlFor="delete-account-confirmation">Type DELETE to confirm</label>
      <input
        id="delete-account-confirmation"
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
      />
      <div className="button-row">
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button className="danger" disabled={value !== 'DELETE' || busy} onClick={onDelete}>
          {pending === 'delete' ? 'Deleting…' : 'Permanently delete account'}
        </button>
      </div>
    </div>
  );
}

function LegalLinks() {
  return (
    <div className="legal-links">
      <a href="/privacy" target="_blank" rel="noreferrer">
        Privacy Policy
      </a>
      <a href="/terms" target="_blank" rel="noreferrer">
        Terms of Service
      </a>
    </div>
  );
}
