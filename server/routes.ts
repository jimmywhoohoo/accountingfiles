import type { Express } from "express";
import { createServer, type Server } from "http";
import { setupAuth } from "./auth";
import { setupWebSocket } from "./websocket";
import { db } from "@db";
import { tasks, users, files, companyProfiles, notificationPreferences, notifications, taskActivities, achievements, userAchievements, documentComments } from "@db/schema";
import { eq, desc, or, asc, and, not, exists } from "drizzle-orm";
import { errorHandler, apiErrorLogger } from "./error-handler";
import { createTaskSchema, updateTaskSchema, updateCompanyProfileSchema, updateNotificationPreferencesSchema } from "@db/schema";
import { sql } from "drizzle-orm";
import { generateThumbnail } from './services/thumbnail';
import path from 'path';
import multer from 'multer';
import fs from 'fs/promises';

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: async function (req, file, cb) {
    const uploadDir = path.join(process.cwd(), 'uploads');
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error as Error, uploadDir);
    }
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

export function registerRoutes(app: Express): Server {
  setupAuth(app);

  // Add error logging middleware
  app.use(apiErrorLogger);

  // Company Profile Routes
  app.get("/api/company-profile", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const [profile] = await db.query.companyProfiles.findMany({
        where: eq(companyProfiles.userId, req.user.id),
        limit: 1,
      });

      res.json(profile || null);
    } catch (error) {
      console.error("Error fetching company profile:", error);
      res.status(500).json({ error: "Failed to fetch company profile" });
    }
  });

  app.post("/api/company-profile/logo", upload.single('logo'), async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const [profile] = await db.query.companyProfiles.findMany({
        where: eq(companyProfiles.userId, req.user.id),
        limit: 1,
      });

      // Delete old logo if it exists
      if (profile?.logo) {
        try {
          await fs.unlink(profile.logo);
        } catch (err) {
          console.error("Error deleting old logo:", err);
        }
      }

      // Update or create company profile with new logo
      if (profile) {
        await db.update(companyProfiles)
          .set({ logo: req.file.path })
          .where(eq(companyProfiles.id, profile.id));
      } else {
        await db.insert(companyProfiles)
          .values({
            userId: req.user.id,
            companyName: req.user.companyName,
            logo: req.file.path,
          });
      }

      res.json({ message: "Logo uploaded successfully" });
    } catch (error) {
      console.error("Error uploading logo:", error);
      res.status(500).json({ error: "Failed to upload logo" });
    }
  });

  app.put("/api/company-profile", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const result = updateCompanyProfileSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          error: "Invalid input: " + result.error.issues.map(i => i.message).join(", ")
        });
      }

      const [profile] = await db.query.companyProfiles.findMany({
        where: eq(companyProfiles.userId, req.user.id),
        limit: 1,
      });

      if (profile) {
        const [updated] = await db.update(companyProfiles)
          .set({ ...result.data, updatedAt: new Date() })
          .where(eq(companyProfiles.id, profile.id))
          .returning();
        res.json(updated);
      } else {
        const [created] = await db.insert(companyProfiles)
          .values({
            userId: req.user.id,
            ...result.data,
          })
          .returning();
        res.json(created);
      }
    } catch (error) {
      console.error("Error updating company profile:", error);
      res.status(500).json({ error: "Failed to update company profile" });
    }
  });

  // Serve company logo
  app.get("/api/company-profile/logo/:id", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const [profile] = await db.query.companyProfiles.findMany({
        where: eq(companyProfiles.id, parseInt(req.params.id)),
        limit: 1,
      });

      if (!profile || !profile.logo) {
        return res.status(404).json({ error: "Logo not found" });
      }

      res.sendFile(profile.logo);
    } catch (error) {
      console.error("Error serving logo:", error);
      res.status(500).json({ error: "Failed to serve logo" });
    }
  });


  // Add notification preferences routes
  app.get("/api/notification-preferences", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const [preferences] = await db.query.notificationPreferences.findMany({
        where: eq(notificationPreferences.userId, req.user.id),
        limit: 1,
      });

      if (!preferences) {
        // Create default preferences if they don't exist
        const [newPreferences] = await db.insert(notificationPreferences)
          .values({
            userId: req.user.id,
          })
          .returning();

        return res.json(newPreferences);
      }

      res.json(preferences);
    } catch (error) {
      console.error("Error fetching notification preferences:", error);
      res.status(500).json({ error: "Failed to fetch notification preferences" });
    }
  });

  app.put("/api/notification-preferences", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const result = updateNotificationPreferencesSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          error: "Invalid input: " + result.error.issues.map(i => i.message).join(", ")
        });
      }

      const [preferences] = await db.query.notificationPreferences.findMany({
        where: eq(notificationPreferences.userId, req.user.id),
        limit: 1,
      });

      if (preferences) {
        const [updated] = await db.update(notificationPreferences)
          .set({
            ...result.data,
            updatedAt: new Date(),
          })
          .where(eq(notificationPreferences.id, preferences.id))
          .returning();
        res.json(updated);
      } else {
        const [created] = await db.insert(notificationPreferences)
          .values({
            userId: req.user.id,
            ...result.data,
          })
          .returning();
        res.json(created);
      }
    } catch (error) {
      console.error("Error updating notification preferences:", error);
      res.status(500).json({ error: "Failed to update notification preferences" });
    }
  });

  // Admin Routes
  app.get("/api/admin/users", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const offset = (page - 1) * limit;

      const allUsers = await db.query.users.findMany({
        orderBy: [asc(users.username)],
        limit,
        offset,
      });

      const totalUsers = await db.select({ count: sql<number>`count(*)` })
        .from(users);

      res.json({
        users: allUsers,
        pagination: {
          total: totalUsers[0].count,
          page,
          limit,
          pages: Math.ceil(totalUsers[0].count / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  app.get("/api/admin/users/:userId/tasks/stats", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const { userId } = req.params;
      const now = new Date();

      const [stats] = await db.select({
        pending: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'pending'::text)`,
        completed: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'completed'::text)`,
        overdue: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'pending'::text AND ${tasks.deadline} < ${now})`,
      })
        .from(tasks)
        .where(eq(tasks.assignedTo, parseInt(userId)));

      res.json(stats);
    } catch (error) {
      console.error("Error fetching user task stats:", error);
      res.status(500).json({ error: "Failed to fetch user task stats" });
    }
  });

  app.get("/api/admin/users/:userId/tasks", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const { userId } = req.params;
      const userTasks = await db.query.tasks.findMany({
        where: eq(tasks.assignedTo, parseInt(userId)),
        orderBy: [desc(tasks.updatedAt)],
        with: {
          assignee: true,
          assigner: true,
        },
      });

      res.json(userTasks);
    } catch (error) {
      console.error("Error fetching user tasks:", error);
      res.status(500).json({ error: "Failed to fetch user tasks" });
    }
  });

  // Get files for a specific user
  app.get("/api/admin/users/:userId/files", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const { userId } = req.params;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const offset = (page - 1) * limit;

      const userFiles = await db.query.files.findMany({
        where: eq(files.uploadedBy, parseInt(userId)),
        orderBy: [desc(files.uploadedAt)],
        limit,
        offset,
      });

      const totalFiles = await db.select({ count: sql<number>`count(*)` })
        .from(files)
        .where(eq(files.uploadedBy, parseInt(userId)));

      res.json({
        files: userFiles,
        pagination: {
          total: totalFiles[0].count,
          page,
          limit,
          pages: Math.ceil(totalFiles[0].count / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching user files:", error);
      res.status(500).json({ error: "Failed to fetch user files" });
    }
  });

  app.put("/api/admin/users/:id", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const { id } = req.params;
      const { role, active } = req.body;

      // Prevent changing own role
      if (parseInt(id) === req.user.id) {
        return res.status(400).json({ error: "Cannot modify own account" });
      }

      const [updatedUser] = await db.update(users)
        .set({
          role: role as string,
          active: active as boolean,
        })
        .where(eq(users.id, parseInt(id)))
        .returning();

      res.json(updatedUser);
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  // File Management Routes
  app.get("/api/admin/files", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const offset = (page - 1) * limit;

      const allFiles = await db.query.files.findMany({
        with: {
          uploader: true,
        },
        orderBy: [desc(files.uploadedAt)],
        limit,
        offset,
      });

      const totalFiles = await db.select({ count: sql<number>`count(*)` })
        .from(files);

      res.json({
        files: allFiles,
        pagination: {
          total: totalFiles[0].count,
          page,
          limit,
          pages: Math.ceil(totalFiles[0].count / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching files:", error);
      res.status(500).json({ error: "Failed to fetch files" });
    }
  });

  // Serve thumbnails
  app.get("/api/files/thumbnail/:id", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { id } = req.params;
      const [file] = await db.select()
        .from(files)
        .where(eq(files.id, parseInt(id)))
        .limit(1);

      if (!file || !file.thumbnailPath) {
        return res.status(404).json({ error: "Thumbnail not found" });
      }

      res.sendFile(file.thumbnailPath);
    } catch (error) {
      console.error("Error serving thumbnail:", error);
      res.status(500).json({ error: "Failed to serve thumbnail" });
    }
  });

  // Handle file upload with thumbnail generation
  app.post("/api/files/upload", upload.single('file'), async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const thumbnailPath = await generateThumbnail(req.file.path);

      const [file] = await db.insert(files)
        .values({
          fileName: req.file.originalname,
          fileType: req.file.mimetype,
          fileSize: req.file.size,
          path: req.file.path,
          thumbnailPath,
          uploadedBy: req.user.id,
        })
        .returning();

      res.json(file);
    } catch (error) {
      console.error("Error uploading file:", error);
      res.status(500).json({ error: "Failed to upload file" });
    }
  });

  // Add delete file endpoint
  app.delete("/api/admin/files/:id", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const { id } = req.params;
      const [file] = await db.select()
        .from(files)
        .where(eq(files.id, parseInt(id)))
        .limit(1);

      if (!file) {
        return res.status(404).json({ error: "File not found" });
      }

      // Delete the actual file and thumbnail
      if (file.path) {
        try {
          await fs.unlink(file.path);
        } catch (err) {
          console.error("Error deleting file:", err);
        }
      }

      if (file.thumbnailPath) {
        try {
          await fs.unlink(file.thumbnailPath);
        } catch (err) {
          console.error("Error deleting thumbnail:", err);
        }
      }

      // Delete the database record
      await db.delete(files)
        .where(eq(files.id, parseInt(id)));

      res.json({ message: "File deleted successfully" });
    } catch (error) {
      console.error("Error deleting file:", error);
      res.status(500).json({ error: "Failed to delete file" });
    }
  });

  // Task Management Routes
  app.post("/api/tasks", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const result = createTaskSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          error: "Invalid input: " + result.error.issues.map(i => i.message).join(", ")
        });
      }

      const { deadline, ...otherData } = result.data;

      const [task] = await db.insert(tasks)
        .values({
          ...otherData,
          deadline: deadline ? new Date(deadline) : null,
          assignedBy: req.user.id,
          status: "pending",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      res.json(task);
    } catch (error) {
      console.error("Error creating task:", error);
      res.status(500).json({ error: "Failed to create task" });
    }
  });

  // Add delete task activities endpoint
  app.delete("/api/admin/tasks/:taskId/activities", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const { taskId } = req.params;

      // Delete all activities for this task
      await db.delete(taskActivities)
        .where(eq(taskActivities.taskId, parseInt(taskId)));

      res.json({ message: "Task activities deleted successfully" });
    } catch (error) {
      console.error("Error deleting task activities:", error);
      res.status(500).json({ error: "Failed to delete task activities" });
    }
  });

  // Update delete task endpoint
  app.delete("/api/admin/tasks/:id", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const { id } = req.params;

      // First delete all activities for this task
      await db.delete(taskActivities)
        .where(eq(taskActivities.taskId, parseInt(id)));

      // Then delete the task
      const [deletedTask] = await db.delete(tasks)
        .where(eq(tasks.id, parseInt(id)))
        .returning();

      if (!deletedTask) {
        return res.status(404).json({ error: "Task not found" });
      }

      res.json({ message: "Task and related activities deleted successfully" });
    } catch (error) {
      console.error("Error deleting task:", error);
      res.status(500).json({ error: "Failed to delete task" });
    }
  });

  // Add task routes for clients
  app.get("/api/tasks", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const userTasks = await db.query.tasks.findMany({
        where: eq(tasks.assignedTo, req.user.id),
        orderBy: [desc(tasks.createdAt)],
        with: {
          assignee: true,
          assigner: true,
        },
      });

      res.json(userTasks);
    } catch (error) {
      console.error("Error fetching tasks:", error);
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });

  app.get("/api/tasks/stats", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const { status, priority, dateRange, search } = req.query;
      const now = new Date();

      let conditions = [eq(tasks.assignedTo, req.user.id)];

      // Add status filter
      if (status && status !== 'all') {
        conditions.push(eq(tasks.status, status as string));
      }

      // Add priority filter
      if (priority && priority !== 'all') {
        conditions.push(eq(tasks.priority, priority as string));
      }

      // Add date range filter
      if (dateRange && dateRange !== 'all') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        switch (dateRange) {
          case 'today':
            conditions.push(sql`DATE(${tasks.createdAt}) = DATE(${today})`);
            break;
          case 'week':
            const weekAgo = new Date(today);
            weekAgo.setDate(weekAgo.getDate() - 7);
            conditions.push(sql`${tasks.createdAt} >= ${weekAgo}`);
            break;
          case 'month':
            const monthAgo = new Date(today);
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            conditions.push(sql`${tasks.createdAt} >= ${monthAgo}`);
            break;
        }
      }

      // Add search filter
      if (search) {
        conditions.push(
          or(
            sql`${tasks.title} ILIKE ${`%${search}%`}`,
            sql`${tasks.description} ILIKE ${`%${search}%`}`
          )
        );
      }

      const whereClause = and(...conditions);

      const [stats] = await db.select({
        pending: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'pending')`,
        completed: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'completed')`,
        overdue: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'pending' AND ${tasks.deadline} < ${now})`,
      })
        .from(tasks)
        .where(whereClause);

      const upcomingDeadlines = await db.query.tasks.findMany({
        where: and(
          whereClause,
          or(
            eq(tasks.status, "pending"),
            eq(tasks.status, "in_progress")
          )
        ),
        orderBy: [asc(tasks.deadline)],
        limit: 5,
        with: {
          assignee: true,
          assigner: true,
        },
      });

      const recentlyCompleted = await db.query.tasks.findMany({
        where: and(whereClause, eq(tasks.status, "completed")),
        orderBy: [desc(tasks.completedAt)],
        limit: 5,
        with: {
          assignee: true,
          assigner: true,
        },
      });

      res.json({
        ...stats,
        upcomingDeadlines,
        recentlyCompleted,
      });
    } catch (error) {
      console.error("Error fetching task stats:", error);
      res.status(500).json({ error: "Failed to fetch task stats" });
    }
  });

  // Fix task update route
  app.put("/api/tasks/:id", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const result = updateTaskSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          error: "Invalid input: " + result.error.issues.map(i => i.message).join(", ")
        });
      }

      const { deadline, ...otherData } = result.data;
      const taskId = parseInt(req.params.id);

      // Get the current task status
      const [currentTask] = await db.select()
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1);

      const [task] = await db.update(tasks)
        .set({
          ...otherData,
          deadline: deadline ? new Date(deadline) : null,
          updatedAt: new Date(),
          ...(result.data.status === 'completed' ? { completedAt: new Date() } : {}),
        })
        .where(eq(tasks.id, taskId))
        .returning();

      if (!task) {
        return res.status(404).json({ error: "Task not found" });
      }

      // Check for achievements if task is completed
      if (result.data.status === 'completed' && currentTask.status !== 'completed') {
        // Get all task-related achievements
        const taskAchievements = await db.query.achievements.findMany({
          where: eq(achievements.category, 'tasks'),
        });

        // Get user's unlocked achievements
        const unlockedAchievements = await db.query.userAchievements.findMany({
          where: eq(userAchievements.userId, req.user.id),
        });

        // Get completed tasks count
        const [completedTasks] = await db
          .select({ count: sql<number>`count(*)` })
          .from(tasks)
          .where(
            and(
              eq(tasks.assignedTo, req.user.id),
              eq(tasks.status, 'completed')
            )
          );

        // Check each achievement
        for (const achievement of taskAchievements) {
          // Skip if already unlocked
          if (unlockedAchievements.some(ua => ua.achievementId === achievement.id)) {
            continue;
          }

          const criteria = achievement.criteria as Record<string, any>;
          if (criteria?.tasksCompleted && completedTasks[0]?.count && completedTasks[0].count >= criteria.tasksCompleted) {
            // Unlock the achievement
            await db.insert(userAchievements)
              .values({
                userId: req.user.id,
                achievementId: achievement.id,
                unlockedAt: new Date(),
                progress: {
                  completedTasks: completedTasks[0].count,
                },
              });

            // Create notification for achievement unlock
            await db.insert(notifications)
              .values({
                userId: req.user.id,
                type: "achievement_unlocked",
                title: "New Achievement Unlocked!",
                message: `You've earned the "${achievement.name}" achievement!`,
                createdAt: new Date(),
              });
          }
        }
      }

      // Add task activity
      if (result.data.status) {
        await db.insert(taskActivities).values({
          taskId: task.id,
          userId: req.user.id,
          action: `changed status to ${result.data.status}`,
          createdAt: new Date(),
        });
      }

      res.json(task);
    } catch (error) {
      console.error("Error updating task:", error);
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  // Notification Routes
  app.get("/api/notifications", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const userNotifications = await db.query.notifications.findMany({
        where: eq(notifications.userId, req.user.id),
        orderBy: [desc(notifications.createdAt)],
        limit: 50,
      });

      res.json(userNotifications);
    } catch (error) {
      console.error("Error fetching notifications:", error);
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  });

  app.post("/api/notifications/mark-all-read", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      await db.update(notifications)
        .set({ read: true })
        .where(eq(notifications.userId, req.user.id));

      res.json({ message: "All notifications marked as read" });
    } catch (error) {
      console.error("Error marking notifications as read:", error);
      res.status(500).json({ error: "Failed to mark notifications as read" });
    }
  });

  app.post("/api/notifications/:id/mark-read", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const [notification] = await db.update(notifications)
        .set({ read: true })
        .where(and(
          eq(notifications.id, parseInt(req.params.id)),
          eq(notifications.userId, req.user.id)
        ))
        .returning();

      if (!notification) {
        return res.status(404).json({ error: "Notification not found" });
      }

      res.json(notification);
    } catch (error) {
      console.error("Error marking notification as read:", error);
      res.status(500).json({ error: "Failed to mark notification as read" });
    }
  });

  // Add achievement routes
  app.get("/api/achievements", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      // Get all achievements with user progress
      const achievements = await db.query.achievements.findMany({
        with: {
          userAchievements: {
            where: eq(userAchievements.userId, req.user.id),
          },
        },
      });

      // Get completed tasks count for progress calculation
      const [completedTasksResult] = await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(tasks)
        .where(
          and(
            eq(tasks.assignedTo, req.user.id),
            eq(tasks.status, "completed")
          )
        );

      const completedTasksCount = completedTasksResult?.count || 0;

      // Get total comments for progress calculation
      const [totalCommentsResult] = await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(documentComments)
        .where(eq(documentComments.userId, req.user.id));

      const totalCommentsCount = totalCommentsResult?.count || 0;

      // Calculate progress for each achievement
      const achievementsWithProgress = achievements.map((achievement) => {
        const userAchievement = achievement.userAchievements[0];
        if (userAchievement) {
          return {
            ...achievement,
            userAchievement,
            progress: 100,
          };
        }

        // Calculate progress based on achievement criteria
        let progress = 0;
        const criteria = achievement.criteria as Record<string, any>;

        switch (achievement.category) {
          case "tasks": {
            if (criteria?.tasksCompleted) {
              progress = Math.min(
                100,
                Math.round((completedTasksCount * 100) / criteria.tasksCompleted)
              );
            }
            break;
          }
          case "collaboration": {
            if (criteria?.commentsPosted) {
              progress = Math.min(
                100,
                Math.round((totalCommentsCount * 100) / criteria.commentsPosted)
              );
            }
            break;
          }
        }

        return {
          ...achievement,
          progress: Math.round(progress),
        };
      });

      res.json(achievementsWithProgress);
    } catch (error) {
      console.error("Error fetching achievements:", error);
      res.status(500).json({ error: "Failed to fetch achievements" });
    }
  });

  // Add achievement check middleware for task completion
  app.put("/api/tasks/:id", async (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      const result = updateTaskSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({
          error: "Invalid input: " + result.error.issues.map(i => i.message).join(", ")
        });
      }

      const { deadline, ...otherData } = result.data;
      const taskId = parseInt(req.params.id);

      // Get the current task status
      const [currentTask] = await db.select()
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1);

      const [task] = await db.update(tasks)
        .set({
          ...otherData,
          deadline: deadline ? new Date(deadline) : null,
          updatedAt: new Date(),
          ...(result.data.status === 'completed' ? { completedAt: new Date() } : {}),
        })
        .where(eq(tasks.id, taskId))
        .returning();

      if (!task) {
        return res.status(404).json({ error: "Task not found" });
      }

      // Check for achievements if task is completed
      if (result.data.status === 'completed' && currentTask.status !== 'completed') {
        // Get all task-related achievements
        const taskAchievements = await db.query.achievements.findMany({
          where: eq(achievements.category, 'tasks'),
        });

        // Get user's unlocked achievements
        const unlockedAchievements = await db.query.userAchievements.findMany({
          where: eq(userAchievements.userId, req.user.id),
        });

        // Get completed tasks count
        const [completedTasks] = await db
          .select({ count: sql<number>`count(*)` })
          .from(tasks)
          .where(
            and(
              eq(tasks.assignedTo, req.user.id),
              eq(tasks.status, 'completed')
            )
          );

        // Check each achievement
        for (const achievement of taskAchievements) {
          // Skip if already unlocked
          if (unlockedAchievements.some(ua => ua.achievementId === achievement.id)) {
            continue;
          }

          const criteria = achievement.criteria as Record<string, any>;
          if (criteria?.tasksCompleted && completedTasks[0]?.count && completedTasks[0].count >= criteria.tasksCompleted) {
            // Unlock the achievement
            await db.insert(userAchievements)
              .values({
                userId: req.user.id,
                achievementId: achievement.id,
                unlockedAt: new Date(),
                progress: {
                  completedTasks: completedTasks[0].count,
                },
              });

            // Create notification for achievement unlock
            await db.insert(notifications)
              .values({
                userId: req.user.id,
                type: "achievement_unlocked",
                title: "New Achievement Unlocked!",
                message: `You've earned the "${achievement.name}" achievement!`,
                createdAt: new Date(),
              });
          }
        }
      }

      // Add task activity
      if (result.data.status) {
        await db.insert(taskActivities).values({
          taskId: task.id,
          userId: req.user.id,
          action: `changed status to ${result.data.status}`,
          createdAt: new Date(),
        });
      }

      res.json(task);
    } catch (error) {
      console.error("Error updating task:", error);
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  // Initialize default achievements if they don't exist
  app.post("/api/admin/achievements/initialize", async (req, res) => {
    if (!req.isAuthenticated() || req.user.role !== "admin") {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const defaultAchievements = [
        {
          name: "Task Master",
          description: "Complete 10 tasks",
          icon: "trophy",
          category: "tasks",
          criteria: { tasksCompleted: 10 },
        },
        {
          name: "Productivity Pro",
          description: "Complete 50 tasks",
          icon: "star",
          category: "tasks",
          criteria: { tasksCompleted: 50 },
        },
        {
          name: "Task Legend",
          description: "Complete 100 tasks",
          icon: "award",
          category: "tasks",
          criteria: { tasksCompleted: 100 },
        },
        {
          name: "Team Player",
          description: "Post 10 comments on documents",
          icon: "users",
          category: "collaboration",
          criteria: { commentsPosted: 10 },
        },
        {
          name: "Document Expert",
          description: "Create or edit 20 documents",
          icon: "file-text",
          category: "documents",
          criteria: { documentsCreated: 20 },
        },
      ];

      for (const achievement of defaultAchievements) {
        const [existing] = await db.select()
          .from(achievements)
          .where(eq(achievements.name, achievement.name))
          .limit(1);

        if (!existing) {
          await db.insert(achievements).values(achievement);
        }
      }

      res.json({ message: "Default achievements initialized successfully" });
    } catch (error) {
      console.error("Error initializing achievements:", error);
      res.status(500).json({ error: "Failed to initialize achievements" });
    }
  });

  // Create HTTP server first
  const httpServer = createServer(app);

  // Set up WebSocket server
  setupWebSocket(httpServer);

  // Add error handler middleware last
  app.use(errorHandler);

  return httpServer;
}