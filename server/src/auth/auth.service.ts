import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { User } from '../entities/user.entity';
import { KakaoLoginDto } from './dto/kakao-login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

interface KakaoTokenResponse {
  access_token: string;
  token_type: string;
  refresh_token: string;
  expires_in: number;
}

interface KakaoUserInfo {
  id: number;
  kakao_account?: {
    email?: string;
    profile?: {
      nickname?: string;
      profile_image_url?: string;
    };
  };
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  async kakaoLogin(dto: KakaoLoginDto) {
    const kakaoToken = await this.exchangeKakaoCode(dto.authorization_code);
    const kakaoUser = await this.getKakaoUserInfo(kakaoToken.access_token);

    const kakaoId = String(kakaoUser.id);
    const email = kakaoUser.kakao_account?.email ?? null;
    const name = kakaoUser.kakao_account?.profile?.nickname ?? '사용자';
    const profileImageUrl =
      kakaoUser.kakao_account?.profile?.profile_image_url ?? null;

    console.log('name:', name, '| hex:', Buffer.from(name).toString('hex'));

    let user = await this.userRepo.findOne({ where: { kakao_id: kakaoId } });
    const isNewUser = !user;

    if (!user) {
      user = this.userRepo.create({
        kakao_id: kakaoId,
        kakao_email: email,
        name,
        profile_image_url: profileImageUrl,
      });
      await this.userRepo.save(user);
    }

    return {
      ...this.issueTokens(user),
      user: {
        id: user.id,
        name: user.name,
        kakao_email: user.kakao_email,
        university: user.university,
        department: user.department,
      },
      is_new_user: isNewUser,
    };
  }

  getKakaoAuthUrl(): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.get<string>('KAKAO_CLIENT_ID')!,
      redirect_uri: this.config.get<string>('KAKAO_REDIRECT_URI')!,
    });
    return `https://kauth.kakao.com/oauth/authorize?${params.toString()}`;
  }

  async updateProfile(userId: number, dto: UpdateProfileDto) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('사용자를 찾을 수 없습니다.');

    user.university = dto.university;
    user.department = dto.department;
    await this.userRepo.save(user);

    return {
      id: user.id,
      name: user.name,
      university: user.university,
      department: user.department,
    };
  }

  async refresh(refreshToken: string) {
    let payload: { sub: number; type: string };
    try {
      payload = this.jwtService.verify(refreshToken, {
        secret: this.config.get<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('유효하지 않은 refresh_token입니다.');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('유효하지 않은 refresh_token입니다.');
    }

    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user) throw new UnauthorizedException('사용자를 찾을 수 없습니다.');
    const { access_token } = this.issueTokens(user);
    return { access_token };
  }

  private issueTokens(user: Pick<User, 'id' | 'name' | 'profile_image_url'>) {
    const secret = this.config.get<string>('JWT_SECRET');
    const access_token = this.jwtService.sign(
      { sub: user.id, name: user.name, picture: user.profile_image_url },
      { secret, expiresIn: this.config.get('JWT_EXPIRES_IN') ?? '7d' },
    );
    const refresh_token = this.jwtService.sign(
      { sub: user.id, type: 'refresh' },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      { secret, expiresIn: '30d' as any },
    );
    return { access_token, refresh_token };
  }

  private async exchangeKakaoCode(code: string): Promise<KakaoTokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.get<string>('KAKAO_CLIENT_ID')!,
      client_secret: this.config.get<string>('KAKAO_CLIENT_SECRET')!,
      redirect_uri: this.config.get<string>('KAKAO_REDIRECT_URI')!,
      code,
    });

    const res = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const err: unknown = await res.json();
      console.error('[Kakao token error]', err);
      throw new UnauthorizedException('카카오 토큰 발급에 실패했습니다.');
    }

    return res.json() as Promise<KakaoTokenResponse>;
  }

  private async getKakaoUserInfo(accessToken: string): Promise<KakaoUserInfo> {
    const res = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new UnauthorizedException(
        '카카오 사용자 정보 조회에 실패했습니다.',
      );
    }

    return res.json() as Promise<KakaoUserInfo>;
  }
}
