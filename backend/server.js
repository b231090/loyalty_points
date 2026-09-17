require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { PrismaClient } = require("@prisma/client");
const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");

const adapter = new PrismaBetterSqlite3({
  url: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({
  adapter,
});

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const tierMultiplier = {
  BRONZE: 1,
  SILVER: 2,
  GOLD: 3,
  PLATINUM: 0.3,
};

let applicationClock = new Date();

function getCurrentClock() {
  return applicationClock;
}

function setCurrentClock(value) {
  const nextClock = new Date(value);
  if (Number.isNaN(nextClock.getTime())) {
    throw new Error("Invalid clock value");
  }
  applicationClock = nextClock;
  return applicationClock;
}

function getTierFromLifetimeSpend(totalSpentCents) {
  if (totalSpentCents >= 500000) return "PLATINUM";

  const totalSpentRupees = totalSpentCents / 100;

  if (totalSpentRupees >= 15000) return "GOLD";
  if (totalSpentRupees >= 5000) return "SILVER";
  return "BRONZE";
}

async function expireStaleEarnedPoints(now = getCurrentClock()) {
  const expiredEvents = await prisma.pointEvent.findMany({
    where: {
      type: "EARN",
      expiresAt: { lte: now },
      expiredAt: null,
    },
    orderBy: { createdAt: "asc" },
  });

  if (!expiredEvents.length) {
    return { expiredPointEvents: 0, expiredPoints: 0 };
  }

  const eventsByMember = new Map();
  for (const event of expiredEvents) {
    const list = eventsByMember.get(event.memberId) || [];
    list.push(event);
    eventsByMember.set(event.memberId, list);
  }

  let expiredPointEvents = 0;
  let expiredPoints = 0;

  for (const [memberId, events] of eventsByMember.entries()) {
    await prisma.$transaction(async (tx) => {
      const currentMember = await tx.member.findUnique({ where: { id: memberId } });
      if (!currentMember) return;

      const claimedEvents = [];
      for (const event of events) {
        const claimed = await tx.pointEvent.updateMany({
          where: {
            id: event.id,
            type: "EARN",
            expiresAt: { lte: now },
            expiredAt: null,
          },
          data: { expiredAt: now },
        });

        if (claimed.count === 1) {
          claimedEvents.push(event);
        }
      }

      if (!claimedEvents.length) return;

      const expiredTotal = claimedEvents.reduce(
        (sum, event) => sum + Number(event.deltaPoints || 0),
        0
      );
      const currentPoints = Number(currentMember.points || 0);
      const actualReduction = Math.min(currentPoints, expiredTotal);
      const nextPoints = Math.max(0, currentPoints - actualReduction);

      if (actualReduction > 0) {
        await tx.member.update({
          where: { id: memberId },
          data: { points: nextPoints },
        });

        await tx.pointEvent.create({
          data: {
            memberId,
            type: "ADJUSTMENT",
            deltaPoints: -actualReduction,
            reason: "Expired earned points",
          },
        });
      }

      expiredPointEvents += claimedEvents.length;
      expiredPoints += actualReduction;
    });
  }

  return { expiredPointEvents, expiredPoints };
}

function signToken(staff) {
  return jwt.sign(
    { id: staff.id, username: staff.username, email: staff.email },
    process.env.JWT_SECRET || "coffee-loyalty-secret",
    { expiresIn: "8h" }
  );
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Missing or invalid token" });
  }

  try {
    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "coffee-loyalty-secret");
    req.staff = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, message: "Loyalty counter API running" });
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, username, password } = req.body;

    if (!name || !email || !username || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const existingStaff = await prisma.staff.findFirst({
      where: { OR: [{ email }, { username }] },
    });

    if (existingStaff) {
      return res.status(409).json({ message: "Staff already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const staff = await prisma.staff.create({
      data: { name, email, username, passwordHash },
      select: { id: true, name: true, email: true, username: true, createdAt: true },
    });

    res.status(201).json({
      message: "Staff registered successfully",
      staff,
      token: signToken({ ...staff, passwordHash: undefined }),
    });
  } catch (error) {
    res.status(500).json({ message: "Registration failed", error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: "Username and password are required" });
    }

    const staff = await prisma.staff.findUnique({ where: { username } });
    if (!staff) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    const valid = await bcrypt.compare(password, staff.passwordHash);
    if (!valid) {
      return res.status(401).json({ message: "Invalid username or password" });
    }

    const safeStaff = {
      id: staff.id,
      name: staff.name,
      email: staff.email,
      username: staff.username,
      createdAt: staff.createdAt,
    };

    res.json({
      message: "Login successful",
      staff: safeStaff,
      token: signToken(safeStaff),
    });
  } catch (error) {
    res.status(500).json({ message: "Login failed", error: error.message });
  }
});

app.post("/api/members", requireAuth, async (req, res) => {
  try {
    const { firstName, lastName, phone, email } = req.body;

    if (!firstName || !lastName || !phone) {
      return res.status(400).json({ message: "First name, last name, and phone are required" });
    }

    const member = await prisma.member.create({
      data: {
        firstName,
        lastName,
        phone,
        email: email || null,
        tier: "BRONZE",
        points: 0,
      },
    });

    res.status(201).json({ member });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(409).json({ message: "Member with this phone already exists" });
    }
    res.status(500).json({ message: "Failed to create member", error: error.message });
  }
});

app.get("/api/members", requireAuth, async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 10);
    const sortBy = req.query.sortBy || "createdAt";
    const order = req.query.order === "asc" ? "asc" : "desc";

    const where = search
      ? {
          OR: [
            { phone: { contains: search } },
            { firstName: { contains: search } },
            { lastName: { contains: search } },
            { email: { contains: search } },
          ],
        }
      : {};

    const [members, total] = await Promise.all([
      prisma.member.findMany({
        where,
        orderBy: { [sortBy]: order },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.member.count({ where }),
    ]);

    res.json({
      members,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch members", error: error.message });
  }
});

app.get("/api/members/search", requireAuth, async (req, res) => {
  try {
    const phone = (req.query.phone || "").trim();
    if (!phone) {
      return res.status(400).json({ message: "Phone is required" });
    }

    const member = await prisma.member.findUnique({ where: { phone } });
    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    res.json({ member });
  } catch (error) {
    res.status(500).json({ message: "Failed to search member", error: error.message });
  }
});

app.get("/api/members/:id", requireAuth, async (req, res) => {
  try {
    const member = await prisma.member.findUnique({
      where: { id: req.params.id },
      include: { purchases: true, redemptions: true, pointEvents: true },
    });

    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    res.json({ member });
  } catch (error) {
    res.status(500).json({ message: "Failed to get member", error: error.message });
  }
});

app.post("/api/purchases", requireAuth, async (req, res) => {
  try {
    const { phone, amountCents } = req.body;

    const purchaseAmountCents = Number(amountCents);

    if (!phone || !amountCents || !Number.isFinite(purchaseAmountCents) || purchaseAmountCents <= 0) {
      return res.status(400).json({ message: "Phone and positive amountCents are required" });
    }

    const member = await prisma.member.findUnique({ where: { phone } });
    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    const previousTier = member.tier;
    const pointsAwarded = (purchaseAmountCents / 100) * Number(tierMultiplier[member.tier] || tierMultiplier.BRONZE);
    const newPoints = Number(member.points) + pointsAwarded;
    const newTotalSpent = member.totalSpent + purchaseAmountCents;
    const newTier = getTierFromLifetimeSpend(newTotalSpent);

    const result = await prisma.$transaction(async (tx) => {
      const updatedMember = await tx.member.update({
        where: { id: member.id },
        data: {
          points: newPoints,
          totalSpent: newTotalSpent,
          tier: newTier,
        },
      });

      const purchase = await tx.purchase.create({
        data: {
          memberId: member.id,
          amountCents: purchaseAmountCents,
          pointsAwarded,
          pointsBalanceAfter: newPoints,
        },
      });

      const expiresAt = new Date(getCurrentClock().getTime() + 90 * 24 * 60 * 60 * 1000);

      await tx.pointEvent.create({
        data: {
          memberId: member.id,
          type: "EARN",
          deltaPoints: pointsAwarded,
          reason: `Purchase of ${purchaseAmountCents} cents`,
          expiresAt,
        },
      });

      if (previousTier !== newTier) {
        await tx.outboxEvent.create({
          data: {
            type: "TIER_CHANGED",
            memberId: member.id,
            payload: JSON.stringify({
              memberId: member.id,
              previousTier,
              newTier,
            }),
          },
        });
      }

      return { purchase, member: updatedMember };
    });

    res.status(201).json({ message: "Purchase recorded", ...result });
  } catch (error) {
    res.status(500).json({ message: "Purchase failed", error: error.message });
  }
});

app.post("/api/redemptions", requireAuth, async (req, res) => {
  try {
    const { phone, itemName, pointsUsed } = req.body;
    const redemptionPoints = Number(pointsUsed);

    if (!phone || !itemName || !pointsUsed || !Number.isFinite(redemptionPoints) || redemptionPoints <= 0) {
      return res.status(400).json({ message: "Phone, itemName, and positive pointsUsed are required" });
    }

    const member = await prisma.member.findUnique({ where: { phone } });
    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    if (Number(member.points || 0) < redemptionPoints) {
      return res.status(400).json({ message: "Insufficient points balance" });
    }

    const newPoints = Math.max(0, Number(member.points || 0) - redemptionPoints);

    const result = await prisma.$transaction(async (tx) => {
      const updatedMember = await tx.member.update({
        where: { id: member.id },
        data: {
          points: newPoints,
        },
      });

      const redemption = await tx.redemption.create({
        data: {
          memberId: member.id,
          itemName,
          pointsUsed: redemptionPoints,
          status: "COMPLETED",
        },
      });

      await tx.pointEvent.create({
        data: {
          memberId: member.id,
          type: "REDEEM",
          deltaPoints: -redemptionPoints,
          reason: `Redeemed ${itemName}`,
        },
      });

      return { redemption, member: updatedMember };
    });

    res.status(201).json({ message: "Redemption processed", ...result });
  } catch (error) {
    res.status(500).json({ message: "Redemption failed", error: error.message });
  }
});

app.post("/api/clock", requireAuth, async (req, res) => {
  try {
    const { now } = req.body;

    if (now) {
      setCurrentClock(now);
    }

    const result = await expireStaleEarnedPoints(getCurrentClock());

    res.json({
      currentClock: getCurrentClock().toISOString(),
      expiredPointEvents: result.expiredPointEvents,
      expiredPoints: result.expiredPoints,
    });
  } catch (error) {
    res.status(400).json({ message: "Invalid clock value", error: error.message });
  }
});

app.get("/api/clock", requireAuth, (req, res) => {
  res.json({ currentClock: getCurrentClock().toISOString() });
});

app.get("/api/outbox", requireAuth, async (req, res) => {
  try {
    const events = await prisma.outboxEvent.findMany({
      orderBy: { createdAt: "desc" },
    });

    res.json({ outboxEvents: events });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch outbox", error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Loyalty API running on http://localhost:${PORT}`);
});