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
};

function getTierFromLifetimeSpend(totalSpentCents) {
  const totalSpentRupees = totalSpentCents / 100;

  if (totalSpentRupees >= 15000) return "GOLD";
  if (totalSpentRupees >= 5000) return "SILVER";
  return "BRONZE";
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

    if (!phone || !amountCents || Number(amountCents) <= 0) {
      return res.status(400).json({ message: "Phone and positive amountCents are required" });
    }

    const member = await prisma.member.findUnique({ where: { phone } });
    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

  const pointsAwarded = Math.floor(
  (Number(amountCents) / 100) * tierMultiplier[member.tier]
);

const newPoints = member.points + pointsAwarded;
const newTotalSpent = member.totalSpent + Number(amountCents);
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
          amountCents: Number(amountCents),
          pointsAwarded,
          pointsBalanceAfter: newPoints,
        },
      });

      await tx.pointEvent.create({
        data: {
          memberId: member.id,
          type: "EARN",
          deltaPoints: pointsAwarded,
          reason: `Purchase of ${amountCents} cents`,
        },
      });

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

    if (!phone || !itemName || !pointsUsed || Number(pointsUsed) <= 0) {
      return res.status(400).json({ message: "Phone, itemName, and positive pointsUsed are required" });
    }

    const member = await prisma.member.findUnique({ where: { phone } });
    if (!member) {
      return res.status(404).json({ message: "Member not found" });
    }

    if (member.points < Number(pointsUsed)) {
      return res.status(400).json({ message: "Insufficient points balance" });
    }

    const newPoints = member.points - Number(pointsUsed);
    const newTier = getTierFromPoints(newPoints);

    const result = await prisma.$transaction(async (tx) => {
      const updatedMember = await tx.member.update({
        where: { id: member.id },
        data: {
          points: newPoints,
          tier: newTier,
        },
      });

      const redemption = await tx.redemption.create({
        data: {
          memberId: member.id,
          itemName,
          pointsUsed: Number(pointsUsed),
          status: "COMPLETED",
        },
      });

      await tx.pointEvent.create({
        data: {
          memberId: member.id,
          type: "REDEEM",
          deltaPoints: -Number(pointsUsed),
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

app.listen(PORT, () => {
  console.log(`Loyalty API running on http://localhost:${PORT}`);
});