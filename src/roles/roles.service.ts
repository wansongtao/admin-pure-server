import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';
import { ConfigService } from '@nestjs/config';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { QueryRoleDto } from './dto/query-role.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class RolesService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private isDefaultAdministrator(roleName: string) {
    const defaultName =
      this.configService.get<string>('DEFAULT_ROLE_NAME') || 'admin';
    return roleName === defaultName;
  }

  async create(createRoleDto: CreateRoleDto) {
    const role = await this.prismaService.role.findFirst({
      where: {
        name: createRoleDto.name,
      },
      select: {
        id: true,
      },
    });
    if (role) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
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
    const role = await this.prismaService.role.findUnique({
      where: {
        id,
      },
      select: {
        name: true,
      },
    });

    if (this.isDefaultAdministrator(role.name)) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'The default administrator role cannot be modified',
      };
    }

    const data: Prisma.RoleUpdateInput = {
      name: updateRoleDto.name,
      description: updateRoleDto.description,
      disabled: updateRoleDto.disabled,
    };
    if (updateRoleDto.permissions) {
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
  }

  remove(id: number) {
    return `This action removes a #${id} role`;
  }

  async findRolesById(ids: number[]) {
    const roleInfos = await this.prismaService.role.findMany({
      where: {
        disabled: false,
        deleted: false,
        id: {
          in: ids,
        },
      },
      select: {
        name: true,
        roleInPermission: {
          select: {
            permissionId: true,
          },
        },
      },
    });

    return roleInfos.map((roleInfo) => {
      return {
        name: roleInfo.name,
        permissionIds: roleInfo.roleInPermission.map(
          (roleInPermission) => roleInPermission.permissionId,
        ),
      };
    });
  }
}
