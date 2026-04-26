import { Injectable } from '@nestjs/common';
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

  async markAsRead(id: string) {
    return this.prisma.notification.update({
      where: { id },
      data: { is_read: true },
    });
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
