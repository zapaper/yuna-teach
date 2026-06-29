import MarketingNav from "@/components/MarketingNav";

export const metadata = {
  title: "Privacy Policy · MarkForYou",
  description: "How MarkForYou collects, uses, and protects your data.",
};

const LAST_UPDATED = "June 2026";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />
      <article className="max-w-3xl mx-auto px-6 pt-24 lg:pt-28 pb-14 text-[#0b1c30]">
        <h1 className="text-3xl font-extrabold mb-1">Privacy Policy</h1>
        <p className="text-sm text-[#737780] mb-10">Last updated: {LAST_UPDATED}</p>

        <p className="mb-6 leading-relaxed">
          MarkForYou (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is operated from
          Singapore and is committed to protecting the privacy of parents and
          students who use our exam-marking service. This policy explains
          what we collect, how we use it, and your rights under Singapore&rsquo;s
          Personal Data Protection Act 2012 (PDPA). MarkForYou is designed
          for Singapore primary-school students (Primary 1 – 6, typically
          ages 7 to 12).
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
          exam papers and compositions, drawings on our digital quiz
          canvases, audio notes recorded when a parent flags a question,
          and AI-generated coaching summaries (such as cross-essay
          &ldquo;Lumi&rsquo;s advice&rdquo;) which may include short verbatim
          excerpts of the student&rsquo;s own writing. These are stored to
          provide AI marking, progress reports, and writing coaching back
          to the family.
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
          (URL, user agent, response time) and a session cookie used to
          keep parents signed in. We do not use third-party advertising or
          behavioural-tracking SDKs.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">2. How we use it</h2>
        <ul className="list-disc pl-6 space-y-2 mb-4 leading-relaxed">
          <li>Provide AI-powered marking, progress reports, writing coaching, and revision tools.</li>
          <li>Authenticate sign-ins, recover accounts, and respond to support requests.</li>
          <li>Bill subscriptions, recognise renewals, and process refunds.</li>
          <li>Detect abuse, protect against fraud, and maintain service availability.</li>
          <li>Improve our marking accuracy by reviewing flagged questions.</li>
          <li>Send transactional emails (welcome, progress updates, Lumi tips, billing receipts). These are part of the service. You can disable progress emails from your account settings at any time.</li>
        </ul>
        <p className="mb-4 leading-relaxed">
          We do <strong>not</strong> sell, rent, or trade personal data, and
          we do not use student work to train external AI models.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">3. Third-party services and data location</h2>
        <p className="mb-3 leading-relaxed">
          Our application servers and primary database are hosted on
          Railway in their <strong>Singapore region</strong>, so the bulk
          of personal data — accounts, exam papers, drawings, audio notes
          — is stored within Singapore. A small number of carefully-chosen
          processors are used for specific tasks, some of which are based
          overseas. Each is bound by their own privacy commitments and
          processes only the minimum data needed:
        </p>
        <ul className="list-disc pl-6 space-y-2 mb-4 leading-relaxed">
          <li><strong>Railway</strong> (Singapore) — application hosting, database, and file storage for uploaded papers and audio notes.</li>
          <li><strong>Cloudflare</strong> (global edge) — content delivery network and R2 object storage for static images (such as avatars and stickers). Cloudflare proxies HTTP requests in transit; it does not retain personal data from those requests.</li>
          <li><strong>Various AI models (including OpenAI, Google Gemini, and Anthropic)</strong> — AI marking, explanation, and writing coaching. Excerpts of student work are sent to these models at request time to generate marks and coaching feedback. We use API tiers that do not retain prompts or completions for training, and outputs are stored only on our Railway database.</li>
          <li><strong>SendGrid</strong> (United States) — sending email and receiving scanned-paper attachments.</li>
          <li><strong>Stripe</strong> (United States, when web subscriptions are enabled) — payment processing.</li>
          <li><strong>Apple App Store / RevenueCat</strong> (when iOS subscriptions are enabled) — payment processing for iOS.</li>
        </ul>
        <p className="mb-3 leading-relaxed">
          Where a processor is based overseas (notably the AI providers,
          SendGrid, and Stripe), the data we send them constitutes a
          cross-border transfer under PDPA s.26. We rely on these
          processors&rsquo; published privacy commitments and standard
          contractual terms to ensure a comparable standard of protection
          to PDPA. We will update this list and notify users via the
          in-app dashboard and email if we materially add to or change our
          processors.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">4. Children&rsquo;s privacy</h2>
        <p className="mb-3 leading-relaxed">
          MarkForYou is designed for parents managing primary-school
          students&rsquo; revision. Student accounts are created and
          administered by parents — children cannot self-register.
          Parents have full visibility of and control over their
          child&rsquo;s account, including the ability to delete it at any
          time. The parent provides consent on the child&rsquo;s behalf at
          sign-up.
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
          We keep account data, exam papers, drawings, audio notes, and
          coaching summaries for as long as the account is active. When a
          parent deletes their account, we delete all linked student
          accounts, exam papers, uploaded media, audio notes, and coaching
          summaries within 30 days. Billing and transaction records are
          retained for 5 years to meet Singapore tax-record requirements.
          Anonymous logs may be retained longer for security analysis
          (typically 90 days).
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">7. Your rights</h2>
        <p className="mb-3 leading-relaxed">
          Under PDPA you have the right to access the personal data we
          hold about you, correct it, withdraw your consent, or request
          deletion. You can:
        </p>
        <ul className="list-disc pl-6 space-y-2 mb-4 leading-relaxed">
          <li>Update your name and email from the in-app settings.</li>
          <li>Delete your account and all linked student accounts from the in-app account-management screen.</li>
          <li>Request a complete copy of the personal data we hold on you (right of access) by emailing our Data Protection Officer at the address below. We will respond within 30 calendar days.</li>
          <li>Disable transactional progress emails from your account settings; you will still receive essential service notices (such as billing receipts).</li>
          <li>Withdraw your consent at any time. Note that withdrawing consent for essential data (such as account email) means we can no longer provide the service.</li>
        </ul>
        <p className="mb-3 leading-relaxed">
          If you are not satisfied with how we handle a privacy request,
          you may lodge a complaint with the Personal Data Protection
          Commission of Singapore at{" "}
          <a href="https://www.pdpc.gov.sg" className="underline text-[#003366]" target="_blank" rel="noopener noreferrer">pdpc.gov.sg</a>.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">8. Security</h2>
        <p className="mb-3 leading-relaxed">
          We use TLS in transit, encrypted backups at rest, and strict
          internal access controls on production data. No system is
          perfectly secure, so we recommend choosing a strong password
          and not reusing it across services.
        </p>
        <p className="mb-3 leading-relaxed">
          In the event of a personal-data breach that is likely to result
          in significant harm or affects 500 or more individuals, we will
          notify the Personal Data Protection Commission within 3 calendar
          days of our assessment, and affected users without undue delay,
          as required under PDPA Part VIA.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">9. Changes to this policy</h2>
        <p className="mb-3 leading-relaxed">
          We may update this policy as the service evolves. Material
          changes will be communicated via the in-app dashboard and via
          email to parents. Continued use of the service after a change
          indicates acceptance of the updated policy.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">10. Contact and Data Protection Officer</h2>
        <p className="mb-3 leading-relaxed">
          For general support email{" "}
          <a href="mailto:hello@markforyou.com" className="underline text-[#003366]">hello@markforyou.com</a>.
        </p>
        <p className="mb-12 leading-relaxed">
          For PDPA access, correction, withdrawal, or deletion requests,
          our Data Protection Officer is{" "}
          <a href="mailto:jessica@markforyou.com" className="underline text-[#003366]">jessica@markforyou.com</a>.
        </p>

        <p className="text-xs text-[#737780]">
          <a href="/terms" className="underline">Terms of Use</a>
          {" · "}
          <a href="/" className="underline">Home</a>
        </p>
      </article>
    </div>
  );
}
