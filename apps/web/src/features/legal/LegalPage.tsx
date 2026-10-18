export function LegalLinks() {
  return (
    <nav className="legal-links" aria-label="Legal">
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
    </nav>
  );
}

/** Product policy copy; material changes must match the implemented controls. */
export function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  return (
    <main className="legal-page">
      <a href="/">← Back to Walden</a>
      <h1>{kind === 'privacy' ? 'Privacy Policy' : 'Terms of Service'}</h1>
      <p className="notice">
        Effective September 20, 2026 · Operated by <a href="https://fultonring.com">Fulton Ring</a>.
      </p>
      {kind === 'privacy' ? (
        <>
          <h2>Information used by Walden</h2>
          <p>
            Walden stores your account identifier, notes, personas, conversation history, and usage
            information to provide the app. The configured authentication provider handles sign-in.
            Your messages and relevant conversation and note context are sent to the configured AI
            provider to generate responses.
          </p>
          <h2>Service providers</h2>
          <p>
            Cloudflare hosts the app and its database and currently provides model inference. Web
            research may send search queries to search services and request pages from other
            websites. PostHog receives browser analytics and server diagnostics. Raw model prompts,
            hidden reasoning, memory, and note context are excluded from those diagnostics.
          </p>
          <h2>Optional conversation sharing</h2>
          <p>
            The Help improve Walden switch is initially on in the first-use notice. After you
            continue with sharing on, new messages and visible replies are sent to PostHog for
            Fulton Ring to diagnose problems, review response quality, evaluate the service, and
            develop and improve Walden features. Authorized team members may review this content.
            Replies may include information from your notes or earlier messages. We do not upload
            past conversations in bulk. We attempt to redact credentials and email addresses; other
            personal or sensitive information may remain. Avoid sharing secrets or sensitive
            information you do not want reviewed.
          </p>
          <p>
            Turn sharing off in Settings → Account at any time. This stops subsequent content
            exports but does not remove previously collected records. We do not use this permission
            to train or fine-tune AI models, sell conversations, target advertising, publish your
            conversations, or conduct unrelated third-party research. Basic operational diagnostics
            continue with sharing off.
          </p>
          <h2>Analytics and browser storage</h2>
          <p>
            Browser analytics records page visits and feature interactions. Automatic click capture
            and session recording are disabled. You can disable browser analytics in Settings →
            Account. This preference applies to this browser; server diagnostics are separate.
            Browser storage also keeps preferences and working drafts.
          </p>
          <h2>Retention and controls</h2>
          <p>
            Thread history follows the retention settings for your account, which may keep history
            indefinitely. Check Settings → Account for your retention period. Notes are stored
            separately until deleted. Settings → Account lets you export available data or delete
            your account. Deletion removes your sign-in identity and application records; provider
            backups and previously collected diagnostics have separate retention periods. PostHog
            removes captured conversation content after 30 days; ordinary diagnostic metadata
            follows its project retention settings and may last longer. Account deletion queues
            deletion of linked PostHog events. Provider deletion is asynchronous. We do not maintain
            a separate indefinite archive of shared conversations for evaluations.
          </p>
          <h2>Your choices and privacy requests</h2>
          <p>
            Fulton Ring operates Walden. Contact{' '}
            <a href="mailto:info@fultonring.com">info@fultonring.com</a> to request access,
            correction, deletion of previously collected diagnostics, or help exercising privacy
            rights. Depending on where you live, you may also have rights to portability,
            restriction, objection, withdrawal of consent, or a complaint to your data protection
            authority. We may verify your identity before fulfilling a request. Service providers
            may process data outside your country, including in the United States.
          </p>
          <h2>Changes</h2>
          <p>
            We will provide notice of material changes to how conversation content is used before
            applying them.
          </p>
        </>
      ) : (
        <>
          <h2>Using Walden</h2>
          <p>
            Walden provides AI-assisted conversations and note-taking. Use it lawfully and only
            submit material you are permitted to share. Do not attempt to access another person’s
            account, interfere with the service, or bypass its safeguards.
          </p>
          <h2>AI responses</h2>
          <p>
            AI responses and citations can be inaccurate or incomplete. Check important information
            and review proposed note changes before accepting them. Walden is not a substitute for
            qualified medical, legal, or financial advice.
          </p>
          <h2>Your content and account</h2>
          <p>
            You retain ownership of your content. Operating the service requires processing and
            storing it and sending relevant context to service providers. Keep your sign-in
            credentials secure. You can export your available data and delete your account in
            Settings.
          </p>
          <h2>Availability and storage</h2>
          <p>
            The app may change or become unavailable. Conversations have limited retention, and AI
            requests can fail or be interrupted. Export information you need to keep.
          </p>
          <h2>Eligibility and ending use</h2>
          <p>
            Use Walden only if you can lawfully agree to these terms. Walden is not intended for
            children under 13. We may restrict accounts that abuse the service or violate these
            terms. You may stop using the service or delete your account at any time.
          </p>
          <h2>Terms and contact</h2>
          <p>
            These terms are between you and Fulton Ring. We will notify users of material changes.
            Nothing here limits rights or remedies that cannot be waived under applicable law.
            Contact <a href="mailto:info@fultonring.com">info@fultonring.com</a> with questions or
            disputes.
          </p>
        </>
      )}
      <LegalLinks />
    </main>
  );
}
