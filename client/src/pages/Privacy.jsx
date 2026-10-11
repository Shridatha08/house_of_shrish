import { Link } from 'react-router-dom';

const UPDATED = '11 October 2026';

export default function Privacy() {
  return (
    <div className="privacy-page">
      <h1>Privacy Policy</h1>
      <p className="privacy-updated">Last updated {UPDATED}</p>

      <p>
        House of Shrish ("we") runs a vegetarian tiffin and meal delivery service in
        Bengaluru, through this website and our Android app. This policy explains what
        we collect, why, and how you can have it removed.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account details</strong> — your name, phone number, delivery address,
          flat number and pincode. Your password is stored only as a salted hash; we
          never see it.
        </li>
        <li>
          <strong>Delivery location</strong> — if you pin your address on the map or tap
          "Use my location", we store those coordinates. We use them to check you are
          inside our 4&nbsp;km delivery area and to plan the driver's route. We never
          collect location in the background or while the app is closed.
        </li>
        <li>
          <strong>Orders and subscriptions</strong> — what you ordered, when, the amount,
          and the delivery status.
        </li>
        <li>
          <strong>Delivery tracking</strong> — while your order is out for delivery, we
          show you your delivery partner's live position, name and phone number so you
          can follow the delivery and reach them. This stops the moment the order is
          delivered. Our drivers share their position only while they are on a run, and
          only from the delivery app with the screen open.
        </li>
        <li>
          <strong>Notification token</strong> — an anonymous device identifier issued by
          Google Firebase Cloud Messaging, so we can tell you when your order is
          confirmed, prepared or out for delivery. Removing the app or logging out
          detaches it.
        </li>
      </ul>

      <h2>What we do not collect</h2>
      <p>
        We do not store card, UPI or bank details. Payments open in your own UPI app and
        are settled there; we only record whether an order has been paid. We do not sell
        or rent your data to anyone, and we do not use it for advertising.
      </p>

      <h2>Who else sees it</h2>
      <ul>
        <li>
          <strong>Our delivery driver</strong> sees your name, phone number and address
          for the orders assigned to them that day, so they can reach you.
        </li>
        <li>
          <strong>Google Firebase Cloud Messaging</strong> delivers our push
          notifications.
        </li>
        <li>
          <strong>Our hosting providers</strong> (Vercel and Render) store the site and
          database on our behalf.
        </li>
        <li>
          <strong>OpenStreetMap</strong> serves the map tiles when you open the location
          picker.
        </li>
      </ul>

      <h2>How long we keep it</h2>
      <p>
        Your account details are kept while your account is open. Completed orders are
        kept for our accounts and tax records; after you delete your account those
        records remain only as amounts and items, with your name, phone number and
        address removed.
      </p>

      <h2 id="delete-account">Deleting your account</h2>
      <p>
        In the Android app, open <strong>Profile</strong> and choose
        {' '}<strong>Delete my account</strong>. On this website you can do the same from
        your <Link to="/profile">profile page</Link>. Deletion is immediate and cannot be
        undone: your profile, saved address, meal subscriptions and notification
        settings are erased, and past orders are stripped of your personal details as
        described above. If you have an order in progress you will be asked to let it
        finish, or cancel it, first.
      </p>
      <p>
        If you would rather we did it for you, message us on{' '}
        <a href="https://wa.me/+919180381854" target="_blank" rel="noreferrer">
          WhatsApp
        </a>{' '}
        or call <a href="tel:+919180381854">+91 91803 81854</a> from your registered
        number, and we will delete the account within 7 days.
      </p>

      <h2>Your choices</h2>
      <p>
        You can edit or correct your details at any time from your profile, turn off
        notifications in your device settings, and decline the location permission — the
        app will then ask you to pin your delivery point on the map instead.
      </p>

      <h2>Children</h2>
      <p>
        Our service is meant for adults placing meal orders and is not directed at
        children under 13.
      </p>

      <h2>Contact</h2>
      <p>
        House of Shrish, Bengaluru, Karnataka, India.
        <br />
        WhatsApp or phone: <a href="tel:+919180381854">+91 91803 81854</a>
        <br />
        FSSAI licence: 21226187002762
      </p>
    </div>
  );
}
