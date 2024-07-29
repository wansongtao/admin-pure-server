import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { getPermissionsKey } from '../common/config/redis.key';
import { Prisma } from '@prisma/client';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { QueryRoleDto } from './dto/query-role.dto';

@Injectable()
export class RolesService {
  constructor(
    private readonly prismaService: PrismaService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  private clearPermissionsCache(userIds: string[]) {
    userIds.forEach(async (userId) => {
      const key = getPermissionsKey(userId);
      const hasKey = await this.redis.exists(key);
      if (hasKey) {
        this.redis.del(key);
      }
    });
  }

  async create(createRoleDto: CreateRoleDto) {
    const role = await this.prismaService.role.findUnique({
      where: {
        name: createRoleDto.name,
      },
      select: {
        id: true,
      },
    });
    if (role) {
      return {
        statusCode: HttpStatus.CONFLICT,
        message: 'The name already exists',
      };
    }

    const data: Prisma.RoleCreateInput = {
      name: createRoleDto.name,
      description: createRoleDto.description,
      disabled: createRoleDto.disabled,
    };
    if (createRoleDto.permissions?.length) {
      data.roleInPermission = {
        create: createRoleDto.permissions.map((permissionId) => ({
          permissionId,
        })),
      };
    }

    await this.prismaService.role.create({
      data,
    });
  }

  async findAll(queryRoleDto: QueryRoleDto) {
    const whereCondition: Prisma.RoleWhereInput = {
      disabled: queryRoleDto.disabled,
      deleted: false,
      name: {
        contains: queryRoleDto.keyword,
        mode: 'insensitive',
      },
      createdAt: {
        gte: queryRoleDto.beginTime,
        lte: queryRoleDto.endTime,
      },
    };

    const results = await this.prismaService.$transaction([
      this.prismaService.role.findMany({
        where: whereCondition,
        select: {
          id: true,
          name: true,
          description: true,
          disabled: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: {
          createdAt: queryRoleDto.sort,
        },
        take: queryRoleDto.pageSize,
        skip: (queryRoleDto.page - 1) * queryRoleDto.pageSize,
      }),
      this.prismaService.role.count({ where: whereCondition }),
    ]);

    return {
      list: results[0],
      total: results[1],
    };
  }

  async findOne(id: number) {
    const role = await this.prismaService.role.findUnique({
      where: {
        id,
        deleted: false,
      },
      select: {
        id: true,
        name: true,
        description: true,
        disabled: true,
        roleInPermission: {
          select: {
            permissionId: true,
          },
        },
      },
    });

    if (!role) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Role not found',
      };
    }

    const permissions = role.roleInPermission.map(
      (roleInPermission) => roleInPermission.permissionId,
    );

    return {
      id: role.id,
      name: role.name,
      description: role.description,
      disabled: role.disabled,
      permissions,
    };
  }

  async update(id: number, updateRoleDto: UpdateRoleDto) {
    if (id === 1) {
      return {
        statusCode: HttpStatus.NOT_ACCEPTABLE,
        message: 'The default administrator role cannot be modified',
      };
    }

    const whereCondition: Prisma.RoleWhereInput = {
      OR: [
        {
          id,
          deleted: false,
        },
      ],
    };
    if (updateRoleDto.name) {
      whereCondition.OR.push({
        name: updateRoleDto.name,
      });
    }
    const roles = await this.prismaService.role.findMany({
      where: whereCondition,
      select: {
        roleInUser: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!roles.length) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Role not found',
      };
    }
    if (roles.length > 1) {
      return {
        statusCode: HttpStatus.CONFLICT,
        message: 'The name already exists',
      };
    }

    const data: Prisma.RoleUpdateInput = {
      name: updateRoleDto.name,
      description: updateRoleDto.description,
      disabled: updateRoleDto.disabled,
    };
    if (updateRoleDto.permissions || updateRoleDto.permissions === null) {
      data.roleInPermission = {
        deleteMany: {},
      };

      if (updateRoleDto.permissions.length) {
        data.roleInPermission.create = updateRoleDto.permissions.map(
          (permissionId) => ({
            permissionId,
          }),
        );
      }
    }

    await this.prismaService.role.update({
      where: {
        id,
      },
      data,
    });

    const role = roles[0];
    if (
      role.roleInUser.length &&
      (updateRoleDto.disabled !== undefined ||
        updateRoleDto.permissions !== undefined)
    ) {
      this.clearPermissionsCache(
        role.roleInUser.map((roleInUser) => roleInUser.userId),
      );
    }
  }

  async remove(id: number) {
    const roleAndUsers: { role_name: string; user_name?: string }[] = await this
      .prismaService.$queryRaw`
      SELECT r.name as role_name, u.user_name
      FROM roles r
      LEFT JOIN role_in_user ur ON ur.role_id = r.id
      LEFT JOIN users u ON u.id = ur.user_id AND u.deleted = false
      WHERE r.id = ${id} AND r.deleted = false
    `;

    if (!roleAndUsers.length) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Role not found',
      };
    }

    if (roleAndUsers.some((item) => item.user_name)) {
      return {
        statusCode: HttpStatus.NOT_ACCEPTABLE,
        message: 'The role has been assigned to the user and cannot be deleted',
      };
    }

    await this.prismaService.role.update({
      where: {
        id,
      },
      data: {
        deleted: true,
      },
    });
  }

  async batchRemove(ids: number[]) {
    const roleAndUsers: { role_name: string; user_name?: string }[] = await this
      .prismaService.$queryRaw`
      SELECT r.name as role_name, u.user_name
      FROM roles r
      LEFT JOIN role_in_user ur ON ur.role_id = r.id
      LEFT JOIN users u ON u.id = ur.user_id AND u.deleted = false
      WHERE r.id IN (${Prisma.join(ids)}) AND r.deleted = false
    `;

    const hasUser = roleAndUsers.some((item) => item.user_name);
    if (hasUser) {
      return {
        statusCode: HttpStatus.NOT_ACCEPTABLE,
        message:
          'Some roles have been assigned to the user and cannot be deleted',
      };
    }

    if (roleAndUsers.length !== ids.length) {
      return {
        statusCode: HttpStatus.NOT_FOUND,
        message: 'Some roles not found',
      };
    }

    await this.prismaService.role.updateMany({
      where: {
        id: {
          in: ids,
        },
      },
      data: {
        deleted: true,
      },
    });
  }

  findAllRoles() {
    return this.prismaService.role.findMany({
      where: {
        disabled: false,
        deleted: false,
      },
      select: {
        id: true,
        name: true,
      },
    });
  }
}
