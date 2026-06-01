import MarketingNav from "@/components/MarketingNav";

export const metadata = {
  title: "Terms of Use · MarkForYou",
  description: "Terms governing your use of the MarkForYou service.",
};

const LAST_UPDATED = "May 2026";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white">
      <MarketingNav />
      <article className="max-w-3xl mx-auto px-6 pt-24 lg:pt-28 pb-14 text-[#0b1c30]">
        <h1 className="text-3xl font-extrabold mb-1">Terms of Use</h1>
        <p className="text-sm text-[#737780] mb-10">Last updated: {LAST_UPDATED}</p>

        <p className="mb-6 leading-relaxed">
          These terms govern your use of the MarkForYou website
          (markforyou.com) and the MarkForYou iOS app (collectively, the
          &ldquo;Service&rdquo;). By creating an account or using the
          Service you agree to these terms. If you do not agree, do not
          use the Service.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">1. Who can use the Service</h2>
        <p className="mb-3 leading-relaxed">
          You must be at least 18 years old or otherwise have legal
          capacity in your jurisdiction to enter into a binding contract.
          Parents or legal guardians may create student accounts on
          behalf of children under 13 and are responsible for those
          children&rsquo;s use of the Service.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">2. Accounts</h2>
        <p className="mb-3 leading-relaxed">
          You are responsible for keeping your password confidential and
          for all activity under your account. Notify us promptly if you
          suspect unauthorised use. We may suspend or terminate accounts
          that violate these terms or applicable law.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">3. Subscriptions and billing</h2>
        <p className="mb-3 leading-relaxed">
          MarkForYou offers a free tier with limited monthly usage and
          paid subscriptions for unlimited usage. Subscriptions are
          billed in advance in the period you select (monthly or
          annually) and renew automatically unless cancelled.
        </p>
        <p className="mb-3 leading-relaxed">
          <strong>iOS subscriptions.</strong> Payment will be charged to
          your Apple Account at confirmation of purchase. Your Apple
          Account will be charged for renewal within 24 hours prior to
          the end of the current period at the price displayed in the
          App Store. Subscriptions automatically renew unless cancelled
          at least 24 hours before the end of the current period. You
          can manage and cancel your subscriptions in your Apple Account
          settings after purchase. Free trials are available only to new
          subscribers; if you have previously taken a trial in the same
          subscription group your purchase will be charged immediately.
        </p>
        <p className="mb-3 leading-relaxed">
          <strong>Web subscriptions.</strong> Billed via Stripe. You can
          manage or cancel from the in-app subscription screen, which
          opens the Stripe customer portal. Cancellations take effect at
          the end of the current billing period; we do not offer
          pro-rated refunds for partial periods.
        </p>
        <p className="mb-3 leading-relaxed">
          Prices may differ between web and iOS to reflect platform fees
          and taxes. The price displayed at checkout is the price you
          pay.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">4. Acceptable use</h2>
        <p className="mb-3 leading-relaxed">You agree NOT to:</p>
        <ul className="list-disc pl-6 space-y-2 mb-4 leading-relaxed">
          <li>Upload content that is illegal, infringing, harassing, or harmful to children.</li>
          <li>Attempt to access other users&rsquo; accounts, scrape, or reverse-engineer the Service.</li>
          <li>Use the Service to build a competing AI product.</li>
          <li>Use the Service beyond the intended parent-and-child(ren) household context — e.g., as a tutoring service across unrelated students, a school-wide tool, or any commercial reuse.</li>
          <li>Resell or sublicense access to the Service.</li>
        </ul>

        <h2 className="text-xl font-bold mt-10 mb-3">5. Your content</h2>
        <p className="mb-3 leading-relaxed">
          You retain ownership of exam papers, drawings, and notes you
          upload. You grant us a limited licence to store, process, and
          display this content as needed to provide the Service to you
          and the linked accounts in your family. We do not use your
          content to train external AI models, and we do not share it
          beyond the third-party processors listed in our Privacy
          Policy.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">6. AI marking — accuracy disclaimer</h2>
        <p className="mb-3 leading-relaxed">
          MarkForYou uses AI to grade exam papers and quizzes. AI marking
          is generally accurate but is not perfect — particularly on
          handwritten, ambiguous, or open-ended responses. Marks awarded
          by the Service are guidance for parents and students; they are
          not a substitute for an official school grade. We provide
          tools (the &ldquo;flag&rdquo; button on each question) for
          parents and students to challenge a mark, and we encourage you
          to use them.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">7. Service availability</h2>
        <p className="mb-3 leading-relaxed">
          We aim for high availability but do not guarantee uninterrupted
          service. We may modify features, perform maintenance, or
          temporarily restrict access. We are not liable for losses
          caused by service interruptions outside our reasonable control.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">8. Termination</h2>
        <p className="mb-3 leading-relaxed">
          You may terminate your account at any time from the in-app
          account-management screen. We may terminate accounts for breach
          of these terms, suspected fraud, or legal compliance
          requirements. Upon termination we will delete your data per
          our Privacy Policy&rsquo;s retention rules.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">9. Limitation of liability</h2>
        <p className="mb-3 leading-relaxed">
          To the maximum extent permitted by law, MarkForYou is provided
          on an &ldquo;as is&rdquo; basis. Our total liability for any
          claim relating to the Service is limited to the amount you
          paid us in the 12 months preceding the claim. We exclude
          liability for indirect or consequential losses.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">10. Governing law</h2>
        <p className="mb-3 leading-relaxed">
          These terms are governed by the laws of the Republic of
          Singapore. Any dispute arising from these terms will be
          resolved by the Singapore courts, unless mandatory consumer
          law in your jurisdiction grants you the right to bring claims
          locally.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">11. Changes to these terms</h2>
        <p className="mb-3 leading-relaxed">
          We may update these terms as the Service evolves. Material
          changes will be communicated via the in-app dashboard and via
          email. Continued use of the Service after a change indicates
          acceptance of the updated terms.
        </p>

        <h2 className="text-xl font-bold mt-10 mb-3">12. Contact</h2>
        <p className="mb-12 leading-relaxed">
          MarkForYou
          <br />
          <a href="mailto:hello@markforyou.com" className="underline text-[#003366]">hello@markforyou.com</a>
        </p>

        <p className="text-xs text-[#737780]">
          <a href="/privacy" className="underline">Privacy Policy</a>
          {" · "}
          <a href="/" className="underline">Home</a>
        </p>
      </article>
    </div>
  );
}
