export const metadata = {
  title: "Privacy Policy · MarkForYou",
  description: "How MarkForYou collects, uses, and protects your data.",
};

const LAST_UPDATED = "May 2026";

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white">
      <article className="max-w-3xl mx-auto px-6 py-14 text-[#0b1c30]">
        <h1 className="text-3xl font-extrabold mb-1">Privacy Policy</h1>
        <p className="text-sm text-[#737780] mb-10">Last updated: {LAST_UPDATED}</p>

        <p className="mb-6 leading-relaxed">
          MarkForYou (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is operated from
          Singapore and is committed to protecting the privacy of parents and
          students who use our exam-marking service. This policy explains
          what we collect, how we use it, and your rights under Singapore&rsquo;s
          Personal Data Protection Act 2012 (PDPA) and applicable
          children&rsquo;s-privacy regulations including the U.S. Children&rsquo;s
          Online Privacy Protection Act (COPPA).
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">1. Information we collect</h2>
        <p className="mb-3 leading-relaxed">
          <strong>Parent accounts.</strong> Email address, optional display
          name, password (hashed at rest where supported by our auth layer),
          IP address at sign-in, and timestamps of activity.
        </p>
        <p className="mb-3 leading-relaxed">
          <strong>Student accounts.</strong> Username chosen by the parent,
          optional display name, primary-school level, password, and
          activity logs (papers attempted, scores, last-login time). We do
          not request any other personal information from children.
        </p>
        <p className="mb-3 leading-relaxed">
          <strong>Submitted school work.</strong> Photos of handwritten
          exam papers, drawings on our digital quiz canvases, and audio
          notes recorded when a parent flags a question. These are stored
          to provide AI marking and progress reports back to the family.
        </p>
        <p className="mb-3 leading-relaxed">
          <strong>Payment metadata.</strong> When a parent subscribes via
          our website we store a Stripe customer ID and subscription
          status. When a parent subscribes via the iOS app we store an
          Apple original-transaction ID and renewal expiry. We do not see
          or store credit-card details — those are handled by Stripe and
          Apple respectively.
        </p>
        <p className="mb-3 leading-relaxed">
          <strong>Device and usage data.</strong> Standard server logs
          (URL, user agent, response time) for security and reliability.
          We do not use third-party advertising or behavioural-tracking
          SDKs.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">2. How we use it</h2>
        <ul className="list-disc pl-6 space-y-2 mb-4 leading-relaxed">
          <li>Provide AI-powered marking, progress reports, and revision tools.</li>
          <li>Authenticate sign-ins, recover accounts, and respond to support requests.</li>
          <li>Bill subscriptions, recognise renewals, and process refunds.</li>
          <li>Detect abuse, protect against fraud, and maintain service availability.</li>
          <li>Improve our marking accuracy by reviewing flagged questions.</li>
        </ul>
        <p className="mb-4 leading-relaxed">
          We do <strong>not</strong> sell, rent, or trade personal data, and
          we do not use student work to train external AI models.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">3. Third-party services</h2>
        <p className="mb-3 leading-relaxed">
          We rely on a small number of carefully-chosen processors to run
          the service. Each is bound by their own privacy commitments and
          processes only the minimum data needed:
        </p>
        <ul className="list-disc pl-6 space-y-2 mb-4 leading-relaxed">
          <li><strong>Railway</strong> — application hosting and database (Singapore region).</li>
          <li><strong>Vercel</strong> — front-end hosting and CDN.</li>
          <li><strong>Stripe</strong> — payment processing (web subscriptions).</li>
          <li><strong>Apple App Store / RevenueCat</strong> — payment processing (iOS subscriptions).</li>
          <li><strong>Google Gemini</strong> — AI marking. We send the relevant question and student answer; nothing is retained by Google for training.</li>
          <li><strong>SendGrid</strong> — sending email and receiving scanned-paper attachments.</li>
        </ul>

        <h2 className="text-xl font-bold mt-10 mb-3">4. Children&rsquo;s privacy</h2>
        <p className="mb-3 leading-relaxed">
          MarkForYou is designed for parents managing primary-school
          students&rsquo; revision. Student accounts are created and
          administered by parents — children cannot self-register.
          Parents have full visibility of and control over their
          child&rsquo;s account, including the ability to delete it at any
          time.
        </p>
        <p className="mb-3 leading-relaxed">
          We do not knowingly collect personal information directly from
          children outside what their parent provides. We do not allow
          children to communicate with anyone outside the service. If you
          believe a child&rsquo;s data has been collected without parental
          consent, contact us at the address below and we will delete it.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">5. Subscriptions and IAP</h2>
        <p className="mb-3 leading-relaxed">
          Subscriptions purchased via the iOS app are billed by Apple and
          managed in your Apple Account. Cancellations and refund
          requests for iOS subscriptions are handled by Apple. Payment
          will be charged to your Apple Account at confirmation of
          purchase. Subscriptions automatically renew at the price stated
          in the App Store unless cancelled at least 24 hours before the
          end of the current period. Subscriptions purchased via the
          website are managed through our Stripe customer portal,
          accessible from the in-app subscription screen.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">6. Data retention</h2>
        <p className="mb-3 leading-relaxed">
          We keep account data for as long as the account is active. When
          a parent deletes their account, we delete all linked student
          accounts, exam papers, and uploaded media within 30 days.
          Anonymous logs may be retained longer for security analysis
          (typically 90 days).
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">7. Your rights</h2>
        <p className="mb-3 leading-relaxed">
          Under PDPA you have the right to access the personal data we
          hold about you, correct it, or request deletion. You can:
        </p>
        <ul className="list-disc pl-6 space-y-2 mb-4 leading-relaxed">
          <li>Update your name and email from the in-app settings.</li>
          <li>Delete your account and all linked student accounts from the in-app account-management screen.</li>
          <li>Email us at <a href="mailto:hello@markforyou.com" className="underline text-[#003366]">hello@markforyou.com</a> for any other request — we will respond within 30 days.</li>
        </ul>

        <h2 className="text-xl font-bold mt-10 mb-3">8. Security</h2>
        <p className="mb-3 leading-relaxed">
          We use TLS in transit, encrypted backups at rest, and strict
          internal access controls on production data. No system is
          perfectly secure, so we recommend choosing a strong password
          and not reusing it across services.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">9. Changes to this policy</h2>
        <p className="mb-3 leading-relaxed">
          We may update this policy as the service evolves. Material
          changes will be communicated via the in-app dashboard and via
          email to parents. Continued use of the service after a change
          indicates acceptance of the updated policy.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">10. Contact</h2>
        <p className="mb-12 leading-relaxed">
          MarkForYou
          <br />
          <a href="mailto:hello@markforyou.com" className="underline text-[#003366]">hello@markforyou.com</a>
        </p>

        <p className="text-xs text-[#737780]">
          <a href="/terms" className="underline">Terms of Use</a>
          {" · "}
          <a href="/" className="underline">Home</a>
        </p>
      </article>
    </main>
  );
}
