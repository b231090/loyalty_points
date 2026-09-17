Reasoning Behind the Loyalty Points Solution

1. Understanding the Problem

The assessment describes a café loyalty counter where staff need to:

Look up a member by phone number.

Record purchases.

Award the correct number of points based on the member's current tier.

Redeem points without allowing the balance to become negative.

Always show the member's current balance.

Support a large member list through search, pagination, and sorting.

The solution was designed around one core principle:

The member's points balance must be derived and updated through controlled, transactional operations so that earning, redemption, and expiration cannot leave the balance inconsistent with its history.

The implementation uses a React/Vite frontend and an Express/Prisma/SQLite backend.

2. Choosing the Data Model

The backend separates the member's current state from the history of point changes.

Member

A Member stores the current:

name

phone number

email

tier

points balance

lifetime spend

The phone number is unique because staff use it as the primary lookup value.

Purchase

A Purchase records:

member

purchase amount in cents

points awarded

points balance after the purchase

creation time

Storing pointsBalanceAfter makes the result of each purchase auditable.

Redemption

A Redemption records:

member

item redeemed

points used

redemption status

creation time

PointEvent

A PointEvent acts as the point ledger. It records:

whether points were earned, redeemed, or adjusted

the point delta

the reason

when earned points expire

whether an expiration has already been processed

This was important for the 90-day expiration requirement because the system needs to know which earned points became stale.

OutboxEvent

An OutboxEvent stores notifications that need to be sent when a member changes tier.

Instead of trying to call an external notification service in the middle of the database update, the tier-change event is recorded in the same transaction. This prevents the database from saying that a tier changed while the notification event was lost.

3. Handling Money Safely

Purchase amounts are stored as integer cents rather than floating-point currency values.

For example:

₹5000 = 500000 cents

This avoids common floating-point problems when calculating monetary totals.

totalSpent therefore remains an integer, while points are stored as Float because the Platinum tier awards 0.3 points per rupee.

4. Tier Logic

The original loyalty levels are represented as:

Tier

Lifetime-spend rule

Points earned

Bronze

below ₹5,000

1 point / ₹

Silver

₹5,000+

2 points / ₹

Gold

₹15,000+

3 points / ₹

Platinum

₹5,000+ according to the assessment twist

0.3 points / ₹

The assessment's Platinum twist overlaps with the earlier Silver/Gold thresholds. To implement the explicit new top-tier requirement, the tier helper checks Platinum first.

The important rule is:

if lifetime spend >= ₹5,000
    Platinum
else
    legacy tier rules

The legacy Bronze/Silver/Gold enum values remain in the database for backward compatibility, while existing members keep their stored values unless a purchase causes them to qualify for the new rule.

Tier calculation is based on lifetime spend, not the current points balance. Redeeming or expiring points therefore does not lower a member's tier.

5. Earning Points

When a purchase is recorded:

The member is loaded.

The member's current tier determines the earning rate.

The purchase amount is converted from cents to rupees.

Points are calculated using the current tier's rate.

Lifetime spend is increased.

The new tier is calculated from the new lifetime spend.

The member balance is updated.

A purchase record is created.

A point ledger event is created.

If the tier changed, an outbox notification event is created.

The important detail is that these database changes happen inside a Prisma transaction.

Conceptually:

purchase
   ↓
calculate points
   ↓
update member balance + lifetime spend
   ↓
create purchase history
   ↓
create point event
   ↓
create tier-change outbox event if needed

This keeps the member state and its history synchronized.

6. Redemption

For a redemption request, the backend first validates that the requested points are positive and finite.

Then it checks:

requested points <= current member balance

If the member does not have enough points, the redemption is rejected.

If the balance is sufficient, the transaction:

subtracts the points,

creates a completed redemption record,

creates a negative PointEvent.

The balance is therefore never intentionally allowed to become negative.

Redemption does not reduce lifetime spend and does not downgrade the member's tier.

7. 90-Day Point Expiration

The second twist requires unused earned points to expire after 90 days.

When points are earned, the corresponding PointEvent receives:

expiresAt = earning time + 90 days

The system exposes a clock endpoint so the expiration logic can be tested deterministically rather than waiting 90 real days.

The expiration job:

finds earned point events whose expiration date has passed,

ignores events already marked as expired,

claims the event inside a transaction,

marks it as expired,

adjusts the member's current balance,

records an adjustment event.

The operation is designed to be idempotent: once an event has an expiredAt timestamp, running the job again does not expire the same event a second time.

8. Tier-Change Notifications

The third twist requires a notification when a member crosses into a new tier.

The purchase transaction compares:

previousTier
newTier

If they differ, an OutboxEvent is created with a TIER_CHANGED event type and a payload containing the member and tier information.

This follows the outbox pattern:

Database change
      ↓
Outbox event
      ↓
Notification service can process event

The benefit is that the notification requirement is represented durably in the database instead of depending on an unreliable direct external call.

The /outbox endpoint exposes these events for verification.

9. Member Lookup and Large Lists

The assessment specifically mentions that the member list is long.

The API therefore supports:

phone-number lookup

search

pagination

sorting

configurable page size

The dedicated phone lookup endpoint supports the counter workflow directly:

GET /api/members/search?phone=<phone>

This avoids forcing staff to manually scan a large list.

10. Authentication

Staff access is protected with JWT authentication.

The flow is:

Register/Login
      ↓
JWT token
      ↓
Frontend stores token
      ↓
Protected API requests send Bearer token

The clock and outbox endpoints are protected because they represent operational/system functionality rather than public member information.

Testing and Debugging Process

11. Initial Backend Validation

After setting up the backend, basic syntax and database setup were checked before moving to the UI.

Commands used included:

node --check server.js
npx prisma db push
npx prisma generate

The health endpoint was then tested:

curl http://localhost:4000/api/health

Expected response:

{
  "ok": true,
  "message": "Loyalty counter API running"
}

This confirmed that the Express server and database client were running.

12. Authentication Test

A staff account was created and the login endpoint was tested.

The login response returned a JWT, which was then used as a Bearer token for protected endpoints.

This verified that the authentication middleware was working before testing protected business operations.

13. Purchase and Tier Test

A test member was created and a purchase was submitted.

The first test exposed an important issue in the tier calculation.

A large purchase was expected to qualify the member for Platinum, but the response initially returned:

GOLD

Why this happened

The original tier helper checked the older Gold threshold before checking the new Platinum threshold.

Therefore, a member qualifying for both rules was being returned as Gold.

Fix

The tier helper was changed so Platinum is checked first:

function getTierFromLifetimeSpend(totalSpentCents) {
  if (totalSpentCents >= 500000) return "PLATINUM";

  const totalSpentRupees = totalSpentCents / 100;

  if (totalSpentRupees >= 15000) return "GOLD";
  if (totalSpentRupees >= 5000) return "SILVER";
  return "BRONZE";
}

The purchase flow was then rechecked.

This was a useful example of why the new requirement had to be treated as an explicit precedence rule rather than simply adding another enum value.

14. Fractional Platinum Points

Another implementation detail came directly from the Platinum rate:

0.3 points / ₹

The original point fields used integer values. That would not correctly represent fractional points.

The point-related fields were therefore changed to Float, including:

Member.points

Purchase.pointsAwarded

Purchase.pointsBalanceAfter

PointEvent.deltaPoints

Redemption.pointsUsed

No flooring or integer rounding was added, because doing so would change the stated earning rate.

The Prisma schema was then synchronized and the Prisma client regenerated.

15. Frontend Testing

The frontend was built and checked with:

npm run build
npm run lint

Both checks passed.

The dashboard was also tested manually in the Codespace browser:

staff login

member phone lookup

member details display

points balance display

purchase form

redemption form

recent activity

16. Fixing the Codespaces API Connection

During frontend testing, the UI initially showed:

Failed to fetch

The backend itself was healthy, so the issue was not the API implementation.

The problem was that the browser was trying to reach the backend directly from the frontend environment.

Fix

The Vite development server was configured with a proxy:

server: {
  proxy: {
    '/api': 'http://localhost:4000',
  },
}

The frontend API base URL was also changed to use the relative /api path during development.

This allowed:

Browser
   ↓
Vite :5174
   ↓
/api proxy
   ↓
Express :4000

After this change, login and dashboard API requests worked correctly in Codespaces.

Design and Frontend Reasoning

17. Dashboard Structure

The frontend was intentionally designed around the counter staff workflow rather than around a generic admin dashboard.

The main flow is:

Login
  ↓
Find member by phone
  ↓
Review current tier + points
  ↓
Record purchase OR redeem points
  ↓
See updated balance/activity

The member's current points balance is kept visually prominent because it is the most important operational value at the café counter.

18. Visual Direction

The interface uses a premium café/editorial visual direction:

warm ivory/off-white background

espresso/dark typography

restrained coffee/caramel accents

large editorial headings

clean cards and spacing

responsive layout

The goal was to make the counter application feel polished without sacrificing the speed of the staff workflow.

Key Engineering Decisions

19. Transactions

Transactions are used whenever multiple pieces of state must change together.

For example, a purchase should not update the member balance successfully while failing to create the corresponding purchase/point history.

The transaction boundary keeps these changes atomic.

20. Ledger + Current Balance

The system keeps both:

Member.points

and:

PointEvent history

The current balance makes the counter fast to read, while the event history makes point changes traceable.

21. Lifetime Spend vs. Points

These are deliberately treated as separate concepts.

Lifetime spend determines tier.

Points balance determines what the member can currently redeem.

Therefore:

earning points can increase both,

redemption decreases points only,

expiration decreases points only,

redemption/expiration do not lower tier.

This prevents loyalty status from unexpectedly changing when a member uses their rewards.

Final Verification

Before the final submission, the project was checked through:

node --check server.js
npx prisma db push
npx prisma generate
npm run build
npm run lint
git diff --check
git status

The main application code was committed and pushed to GitHub, followed by the assessment documentation.

The final Git push reported:

c35c448..709ae44  main -> main

which confirmed that the documentation commit was successfully pushed to the remote main branch.

Conclusion

The solution focuses on keeping the loyalty balance correct under the three assessment twists:

Tier compatibility — Platinum was added with explicit precedence for the new requirement.

Point expiration — earned points receive expiration dates and are processed through an idempotent expiration operation.

Tier notifications — tier changes create durable outbox events inside the same transaction as the purchase update.

The combination of transactional updates, a point-event ledger, explicit tier calculation, protected APIs, deterministic clock testing, and a staff-focused frontend provides a consistent end-to-end loyalty counter workflow.