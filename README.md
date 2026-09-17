Loyalty Points Counter

A café loyalty counter application where staff can look up members by
phone number, record purchases, award points according to tier, redeem
points, and keep balances consistent.

Tech stack

Backend: Node.js + Express

Database: SQLite

ORM: Prisma 7

Authentication: JWT + bcrypt

Frontend: React + Vite

Development environment: GitHub Codespaces

Setup

Backend

cd backend
npm install
npx prisma db push
npx prisma generate
node server.js

Backend runs on port 4000.

Health check:

curl http://localhost:4000/api/health

Frontend

In a second terminal:

cd frontend
npm install
npm run dev

Vite uses the available local port (for example 5173 or 5174).

The frontend uses a Vite development proxy so /api requests are
forwarded to http://localhost:4000.

Authentication

Staff register/login through the auth endpoints. Protected endpoints
use:

Authorization: Bearer <JWT>

Do not commit .env or secrets.

Business rules

Members have a unique phone number.

Lifetime spend is stored in cents.

Points are stored as fractional values because Platinum earns 0.3
points per rupee.

A purchase records the amount, points awarded, and resulting points
balance.

A redemption cannot exceed the current points balance.

Redemption does not downgrade a member's tier.

Earned points receive a 90-day expiration timestamp based on the
application clock.

The expiration job marks expired earning events so the same event is
not expired twice.

A tier transition creates a TIER_CHANGED outbox event in the same
purchase transaction.

Platinum is checked first at lifetime spend of ₹5,000 or more; the
legacy Bronze/Silver/Gold enum values remain for backward
compatibility.

API endpoints

Method                  Endpoint                              Purpose

GET                     /api/health                         Health check

POST                    /api/auth/register                  Register staff

POST                    /api/auth/login                     Login and receive JWT

POST                    /api/members                        Create member

GET                     /api/members                        List members with
search/pagination/sorting

GET                     /api/members/search?phone=<phone>   Search member by phone

GET                     /api/members/:id                    Get member by ID

POST                    /api/purchases                      Record purchase and award
points

POST                    /api/redemptions                    Redeem points

POST                    /api/clock                          Advance application clock
and expire stale points

GET                     /api/clock                          Read application clock

Pagination and sorting

GET /api/members supports server-side search, pagination, and sorting
so the long member list does not need to be loaded completely into the
browser.

Debugging

After changing the Prisma schema:

cd backend
npx prisma db push
npx prisma generate
node --check server.js

Frontend checks:

cd frontend
npm run build
npm run lint

If the frontend cannot reach the backend in Codespaces, restart Vite
after changes to vite.config.js. The development proxy maps /api to
http://localhost:4000.

Validation performed

Backend health endpoint tested successfully.

Staff login tested successfully and returned a JWT.

Fresh member creation tested successfully.

₹5,000 purchase tested successfully and awarded 5,000 points.

A tier precedence issue was found during testing and corrected so
the Platinum threshold is checked first.

Frontend initially showed Failed to fetch in Codespaces; the
connection was fixed using the Vite proxy.

npm run build passed.

npm run lint passed.

node --check server.js passed.
