import { Link } from 'react-router-dom';

// Kept in step with the app's lib/features/legal/privacy_screen.dart. Bump
// PRIVACY_VERSION with every change: registration records which version each
// customer agreed to.
export const PRIVACY_VERSION = '2026-11-11';
const UPDATED = '11 November 2026';
const PHONE = '+91 91803 81854';
const EMAIL = 'houseofshrish@gmail.com';

export default function Privacy() {
  return (
    <div className="privacy-page">
      <h1>Privacy Notice</h1>
      <p className="privacy-updated">Last updated {UPDATED}</p>

      <p>
        House of Shrish runs a vegetarian meal delivery service in Bengaluru through this
        website and our Android and iPhone apps. This notice explains what personal data we
        collect, why, who we share it with, how long we keep it, and how you can exercise your
        rights under the Digital Personal Data Protection Act, 2023 (DPDP Act).
      </p>

      <h2>Who we are</h2>
      <p>
        The Data Fiduciary responsible for your data is <strong>Ashwini S, trading as House
        of Shrish</strong>, C V Raman Nagar, Bengaluru, Karnataka, India. Our Grievance
        Officer is <strong>Ashwini S</strong>, reachable at{' '}
        <a href={`mailto:${EMAIL}?subject=Privacy%20request`}>{EMAIL}</a> or{' '}
        <a href="tel:+919180381854">{PHONE}</a>.
      </p>

      <h2>What we collect and why</h2>
      <p>We collect only what we need to take, deliver and account for your orders.</p>
      <dl>
        <dt>Account details</dt>
        <dd>
          Name, phone number and a password, stored only as a salted hash that we cannot
          read. Used to create your account, sign you in and contact you about your orders.
        </dd>
        <dt>Delivery details</dt>
        <dd>
          Delivery address, flat or door number, pincode and, if you pin it on the map or
          tap "Use my location", the coordinates of your delivery point. Used to deliver to
          you, check you are inside our delivery area and plan the driver's route. We never
          collect location in the background or while the app is closed.
        </dd>
        <dt>Orders and subscriptions</dt>
        <dd>
          What you ordered, when, the amount, the delivery and payment status, your meal
          plans and the meals you skip, and GST invoices. Used to prepare and deliver your
          food, run your subscription, and keep the accounts and tax records the law requires.
        </dd>
        <dt>Referrals and wallet</dt>
        <dd>
          Your referral code, who referred you, and your wallet balance with the credits and
          deductions behind it. Used to give you and the person who referred you the credit
          you earned.
        </dd>
        <dt>Feedback</dt>
        <dd>
          Messages you send us through Feedback, together with your name and phone number.
          Used to reply to you and improve our food and service.
        </dd>
        <dt>Notifications</dt>
        <dd>
          A notification token for your device, if you allow notifications. Used only to tell
          you about your orders and plan.
        </dd>
        <dt>Guest orders</dt>
        <dd>
          The name, phone number and address on an order placed without an account. Used
          only to deliver and support that order.
        </dd>
      </dl>

      <h2>Your consent</h2>
      <p>
        When you create an account you agree to this notice. We process your data for the
        purposes above on the basis of that consent and, for an order you place, because you
        gave us the details to fulfil it. Location and notifications are optional; you can
        refuse or switch them off at any time in your device settings and still pin your
        address on the map by hand.
      </p>
      <p>
        You can withdraw your consent at any time by deleting your account, or by contacting
        us. Withdrawing is as easy as giving consent. It does not affect what was done
        before, and we will stop processing your data unless the law requires us to keep it.
      </p>

      <h2>Who we share it with</h2>
      <p>We do not sell or rent your data, and we do not use it for advertising.</p>
      <ul>
        <li>
          <strong>Our delivery partner</strong> sees your name, phone number and address for
          the orders assigned to them that day, so they can reach you.
        </li>
        <li>
          <strong>Someone whose referral code you used</strong> is told your first name when
          your first order is confirmed, so they know which referral earned their credit;
          never your phone number or address.
        </li>
        <li>
          <strong>Service providers</strong> process data for us under our instructions:
          Render (hosts our servers), Vercel (hosts this website), MongoDB (stores our
          database), Google Firebase (delivers notifications, through Apple's push
          notification service on iPhones) and YouPI (our online UPI payment gateway, which
          receives your name, phone number and the order amount).
        </li>
        <li>
          <strong>Maps and address lookup.</strong> OpenStreetMap supplies the map and, when
          you pin your address, receives those coordinates to look up the street name. Your
          phone's own location service (Google on most Android phones, Apple on iPhones) may
          also be used.
        </li>
        <li>
          <strong>Payments.</strong> UPI payments are settled by your own UPI app and bank.
          We never see or store card, UPI PIN or bank details; we only record whether an
          order was paid and its payment reference.
        </li>
        <li>
          <strong>Government and courts</strong>, when the law requires it, for example tax
          authorities or a lawful request from the police or a court.
        </li>
      </ul>

      <h2>Where it is stored</h2>
      <p>
        Our servers and service providers may store and process your data outside India.
        Any such transfer follows the DPDP Act, and never to a country the Government of
        India has restricted.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>
          Account details, address, wallet, referral record, feedback and notification tokens
          are kept while your account is open and erased when you delete it.
        </li>
        <li>
          Orders and invoices are kept for as long as tax and accounting law requires. Once
          your account is deleted they keep only the items and amounts, with your name, phone
          number and address removed.
        </li>
        <li>
          Your delivery partner's live position is used only while your order is on its way.
          Password reset requests are kept only until they are used or expire.
        </li>
        <li>Copies in our backups are removed as those backups are replaced.</li>
      </ul>

      <h2 id="your-rights">Your rights</h2>
      <p>
        Under the DPDP Act you can ask us for the following. Most of it you can do yourself;
        for the rest, contact the Grievance Officer. We reply within 30 days, and at the
        latest within 90 days.
      </p>
      <ul>
        <li><strong>Access:</strong> a summary of the personal data we hold about you, what we do with it, and who we have shared it with.</li>
        <li><strong>Correct, complete or update</strong> your details at any time from your <Link to="/profile">profile</Link>, or by asking us.</li>
        <li id="delete-account">
          <strong>Erase</strong> your account and data: in the app open <strong>Profile</strong> and
          choose <strong>Delete my account</strong>, or do the same from your{' '}
          <Link to="/profile">profile page</Link> here. It is immediate and cannot be undone.
          Your wallet balance is erased with it, so spend any credit first; credit already
          paid to someone who referred you stays with them. If an order is in progress you
          will be asked to let it finish, or cancel it, first. You can also message us on{' '}
          <a href="https://wa.me/+919180381854" target="_blank" rel="noreferrer">WhatsApp</a>{' '}
          or call from your registered number, and we will delete it within 7 days.
        </li>
        <li><strong>Nominate</strong> someone to exercise these rights for you if you die or become unable to, by telling the Grievance Officer who they are.</li>
        <li><strong>Raise a grievance</strong> with us first. If you are not satisfied with our reply, you can complain to the Data Protection Board of India.</li>
      </ul>

      <h2>Children</h2>
      <p>
        Accounts are for people aged 18 or over. We do not knowingly collect data from
        children. If you believe a child has given us their details, contact us and we will
        delete them.
      </p>

      <h2>Keeping it safe</h2>
      <p>
        Data travels over encrypted connections, passwords are stored only as salted hashes,
        and access is limited to the people who need it to serve you. If a breach ever
        affects your data, we will tell you and the Data Protection Board as the law requires.
      </p>

      <h2>Your part</h2>
      <p>
        Please give us accurate details, do not use someone else's identity, and do not file
        false or frivolous complaints. These are your duties under the DPDP Act.
      </p>

      <h2>Language and changes</h2>
      <p>
        Ask us and we will provide this notice in any language listed in the Eighth Schedule
        to the Constitution. If we change it, we will publish the new version here and in the
        app and update the date above.
      </p>

      <h2>Contact</h2>
      <p>
        House of Shrish, C V Raman Nagar, Bengaluru, Karnataka, India.
        <br />
        Grievance Officer: Ashwini S ·{' '}
        <a href={`mailto:${EMAIL}?subject=Privacy%20request`}>{EMAIL}</a> ·{' '}
        <a href="tel:+919180381854">{PHONE}</a>
        <br />
        FSSAI licence: 21226187002762
      </p>
    </div>
  );
}
