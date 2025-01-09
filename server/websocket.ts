import { WebSocket, WebSocketServer } from 'ws';
import type { Server } from 'http';
import { db } from '@db';
import { eq, and, sql } from 'drizzle-orm';
import { tasks, taskActivities, users, documentComments } from '@db/schema';
import { randomUUID } from 'crypto';

interface Client {
  id: string;
  ws: WebSocket;
  userId: number;
  username: string;
}

interface TaskUpdate {
  type: 'task_update';
  taskId: number;
  changes: {
    status: 'pending' | 'completed' | 'in_progress' | 'cancelled';
    completedAt: string | null;
    updatedAt: string;
  };
  userId: number;
}

interface TeamPerformanceUpdate {
  type: 'team_performance';
  members: Array<{
    id: number;
    username: string;
    fullName: string;
    role: string;
    metrics: {
      tasksCompleted: number;
      onTimeCompletion: number;
      documentComments: number;
      collaborationScore: number;
      totalScore: number;
    };
  }>;
}

type Message = TaskUpdate | { type: 'subscribe_team_performance' };

async function calculateTeamPerformance() {
  const teamMembers = await db.query.users.findMany({
    where: eq(users.role, 'team_member'),
  });

  const performanceMetrics = await Promise.all(
    teamMembers.map(async (member) => {
      // Calculate tasks completed
      const [tasksCompleted] = await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(tasks)
        .where(
          and(
            eq(tasks.assignedTo, member.id),
            eq(tasks.status, 'completed')
          )
        );

      // Calculate on-time completion rate
      const [totalTasks] = await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(tasks)
        .where(eq(tasks.assignedTo, member.id));

      const [onTimeTasks] = await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(tasks)
        .where(
          and(
            eq(tasks.assignedTo, member.id),
            eq(tasks.status, 'completed'),
            sql`tasks.completed_at <= tasks.deadline`
          )
        );

      const onTimeCompletionRate = totalTasks.count > 0
        ? Math.round((onTimeTasks.count / totalTasks.count) * 100)
        : 100;

      // Calculate document comments
      const [comments] = await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(documentComments)
        .where(eq(documentComments.userId, member.id));

      // Calculate collaboration score based on task activities
      const [activities] = await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(taskActivities)
        .where(eq(taskActivities.userId, member.id));

      const collaborationScore = Math.min(100, activities.count);

      // Calculate total score (weighted average)
      const totalScore = Math.round(
        (tasksCompleted.count * 40 +
          onTimeCompletionRate * 30 +
          Math.min(comments.count * 10, 100) * 15 +
          collaborationScore * 15) / 100
      );

      return {
        id: member.id,
        username: member.username,
        fullName: member.fullName,
        role: member.role,
        metrics: {
          tasksCompleted: tasksCompleted.count,
          onTimeCompletion: onTimeCompletionRate,
          documentComments: comments.count,
          collaborationScore,
          totalScore,
        },
      };
    })
  );

  return performanceMetrics;
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({
    server,
    verifyClient: (info: any) => {
      return !info.req.headers['sec-websocket-protocol']?.includes('vite-hmr');
    }
  });

  const clients = new Map<string, Client>();
  const performanceSubscribers = new Set<string>();

  const broadcastTeamPerformance = async () => {
    const performanceMetrics = await calculateTeamPerformance();
    const message: TeamPerformanceUpdate = {
      type: 'team_performance',
      members: performanceMetrics,
    };

    performanceSubscribers.forEach(clientId => {
      const client = clients.get(clientId);
      if (client?.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(JSON.stringify(message));
        } catch (err) {
          console.error('Failed to send team performance update:', err);
        }
      }
    });
  };

  const broadcastToClients = (message: any, excludeClientId?: string) => {
    clients.forEach((client, clientId) => {
      if (excludeClientId && clientId === excludeClientId) return;

      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(JSON.stringify(message));
        } catch (err) {
          console.error('Failed to broadcast to client:', err);
        }
      }
    });
  };

  wss.on('connection', (ws) => {
    const clientId = randomUUID();

    ws.on('message', async (data) => {
      let parsedMessage: Message;

      try {
        parsedMessage = JSON.parse(data.toString());
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error);
        ws.send(JSON.stringify({
          type: 'error',
          code: 'MESSAGE_PARSE_ERROR',
          message: 'Invalid message format'
        }));
        return;
      }

      const client = clients.get(clientId);
      if (!client) return;

      if (parsedMessage.type === 'subscribe_team_performance') {
        performanceSubscribers.add(clientId);
        // Send initial performance data
        broadcastTeamPerformance();
      }

      // Handle task updates and recalculate team performance
      if (parsedMessage.type === 'task_update' && parsedMessage.taskId && parsedMessage.changes) {
        try {
          // Fetch current task status
          const [currentTask] = await db
            .select()
            .from(tasks)
            .where(eq(tasks.id, parsedMessage.taskId))
            .limit(1);

          if (!currentTask) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'TASK_NOT_FOUND',
              message: 'Task not found'
            }));
            return;
          }

          // Validate status transition
          const validation = validateTaskUpdate(currentTask.status, parsedMessage.changes.status);
          if (!validation.isValid) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'INVALID_STATUS_TRANSITION',
              message: validation.message
            }));
            return;
          }

          // Update task in database
          const [updatedTask] = await db
            .update(tasks)
            .set({
              status: parsedMessage.changes.status,
              completedAt: parsedMessage.changes.completedAt ? new Date(parsedMessage.changes.completedAt) : null,
              updatedAt: new Date(parsedMessage.changes.updatedAt)
            })
            .where(eq(tasks.id, parsedMessage.taskId))
            .returning();

          // Create task activity record
          const [activity] = await db
            .insert(taskActivities)
            .values({
              taskId: parsedMessage.taskId,
              userId: client.userId,
              action: `Status changed from ${currentTask.status} to ${parsedMessage.changes.status}`,
              createdAt: new Date()
            })
            .returning();

          if (updatedTask) {
            // Broadcast task update to all clients
            broadcastToClients({
              type: 'task_update',
              task: updatedTask,
              activity: {
                id: activity.id,
                action: activity.action,
                createdAt: activity.createdAt,
                user: {
                  id: client.userId,
                  username: client.username
                }
              }
            }, clientId);

            // Send success response to the originating client
            ws.send(JSON.stringify({
              type: 'task_update_success',
              task: updatedTask,
              activity: {
                id: activity.id,
                action: activity.action,
                createdAt: activity.createdAt,
                user: {
                  id: client.userId,
                  username: client.username
                }
              }
            }));
          }
        } catch (error) {
          console.error('Database update error:', error);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'DATABASE_ERROR',
            message: 'Failed to update task in database'
          }));
        }
      }
    });

    ws.on('close', () => {
      performanceSubscribers.delete(clientId);
      clients.delete(clientId);
    });

    // Handle client authentication
    ws.once('message', (data) => {
      try {
        const { userId, username } = JSON.parse(data.toString());
        if (userId && username) {
          clients.set(clientId, { id: clientId, ws, userId, username });

          ws.send(JSON.stringify({
            type: 'connected',
            message: 'Successfully connected to real-time updates'
          }));
        }
      } catch (error) {
        console.error('WebSocket auth error:', error);
        ws.close();
      }
    });
  });

  // Periodically update team performance (every 30 seconds)
  setInterval(() => {
    if (performanceSubscribers.size > 0) {
      broadcastTeamPerformance();
    }
  }, 30000);

  return wss;
}

function validateTaskUpdate(currentStatus: string, newStatus: string): { isValid: boolean; message?: string } {
  const validTransitions: Record<string, string[]> = {
    'pending': ['in_progress', 'completed', 'cancelled'],
    'in_progress': ['completed', 'cancelled', 'pending'],
    'completed': ['pending'],
    'cancelled': ['pending']
  };

  if (!validTransitions[currentStatus]) {
    return { isValid: false, message: `Invalid current status: ${currentStatus}` };
  }

  if (!validTransitions[currentStatus].includes(newStatus)) {
    return { 
      isValid: false, 
      message: `Cannot change task status from '${currentStatus}' to '${newStatus}'. Valid transitions are: ${validTransitions[currentStatus].join(', ')}`
    };
  }

  return { isValid: true };
}