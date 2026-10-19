// Read-only check of why a referral did or did not pay out.
//
//   MONGODB_URI='...' node scripts/referral-status.mjs
//
// Prints each customer's referral wiring, their orders, and any wallet
// movements, so a missing credit can be traced to the step that broke.
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is required.');
  process.exit(2);
}

const client = await new MongoClient(uri).connect();
const database = client.db(process.env.MONGODB_DB_NAME || 'house_of_shrish');

try {
  const users = await database.collection('users').find({}).toArray();
  const orders = await database.collection('orders').find({}).toArray();
  const entries = await database.collection('walletEntries').find({}).toArray();
  const byId = new Map(users.map((user) => [user.id, user]));

  console.log(`${users.length} customers, ${orders.length} orders, ${entries.length} wallet entries\n`);

  for (const user of users) {
    const referrer = user.referredBy ? byId.get(user.referredBy) : null;
    console.log(`${user.name} (${user.phone})`);
    console.log(`  code         : ${user.referralCode || 'NONE'}`);
    console.log(`  referred by  : ${user.referredBy ? `${referrer ? referrer.name : 'unknown'} [${user.referredBy}]` : 'nobody'}`);
    console.log(`  rewarded at  : ${user.referralRewardedAt || 'not yet'}`);
    console.log(`  balance      : ₹${user.walletBalance || 0}`);

    const theirs = orders.filter((order) => order.userId === user.id);
    if (theirs.length === 0) {
      console.log('  orders       : none linked to this account');
    }
    for (const order of theirs) {
      console.log(`  order #${order.orderNumber} : status=${order.status} payment=${order.paymentStatus} total=₹${order.total}`);
    }

    const mine = entries.filter((entry) => entry.userId === user.id);
    for (const entry of mine) {
      console.log(`  wallet       : ${entry.amount > 0 ? '+' : ''}${entry.amount} (${entry.reason}) ${entry.createdAt}`);
    }
    console.log();
  }

  const guestOrders = orders.filter((order) => !order.userId);
  if (guestOrders.length > 0) {
    console.log(`${guestOrders.length} order(s) are not linked to any account, so they can never settle a referral:`);
    for (const order of guestOrders) {
      console.log(`  #${order.orderNumber} ${order.customer?.phone || ''} status=${order.status}`);
    }
  }
} finally {
  await client.close();
}
