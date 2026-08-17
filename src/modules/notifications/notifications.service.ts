import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async findByUser(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { user_id: userId },
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.notification.count({ where: { user_id: userId } }),
      this.prisma.notification.count({ where: { user_id: userId, is_read: false } }),
    ]);

    return { data, unread_count: unread, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // Scoped to the caller and returns only a status: the notification body can
  // carry order details, so returning the updated row let any authenticated
  // user read (and flip) someone else's notification by id.
  async markAsRead(id: string, userId: string) {
    const res = await this.prisma.notification.updateMany({
      where: { id, user_id: userId },
      data: { is_read: true },
    });
    if (res.count === 0) {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found',
      });
    }
    return { message: 'Notification marked as read' };
  }

  async markAllAsRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { user_id: userId, is_read: false },
      data: { is_read: true },
    });
    return { message: 'All notifications marked as read' };
  }

  async create(userId: string, type: string, title: string, body: string, data?: any) {
    return this.prisma.notification.create({
      data: { user_id: userId, type, title, body, data },
    });
  }
}
