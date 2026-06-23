import { BadRequestException } from '@nestjs/common';
import { TeamsService } from './teams.service';
import { UpdateTeamSettingsDto } from './dto/update-team-settings.dto';

// updateSettings()의 검증 로직(가중치 합·지각 최대시간)만 단위로 검증한다.
// 다른 의존성은 이 메서드 경로에서 쓰이지 않으므로 null로 주입한다.
describe('TeamsService.updateSettings — 설정값 검증', () => {
  const LEADER_MEMBERSHIP = { team_id: 1, user_id: 1, role: 'leader' };
  const BASE_SETTINGS = {
    team_id: 1,
    punctuality_grace_ratio: 0.1,
    max_utterance_chars: 500,
    presence_grace_seconds: 30,
    absent_meeting_handling: 'exclude',
    deadline_penalty_curve: 'standard',
    contribution_visibility: 'team',
    min_meeting_minutes: 5,
    final_task_weight: 0.5,
    weight_speech_in_meeting: 0.6,
    weight_attend_in_meeting: 0.4,
    leader_bonus_multiplier: 1.0,
    late_threshold_minutes: 5,
    late_max_minutes: 0,
    slack_bot_token: null,
    slack_channel_id: null,
  };

  function makeService(settingsOverride: Partial<typeof BASE_SETTINGS> = {}) {
    const settings = { ...BASE_SETTINGS, ...settingsOverride };
    const membershipRepo = {
      findOne: jest.fn().mockResolvedValue(LEADER_MEMBERSHIP),
    };
    const settingsRepo = {
      findOne: jest.fn().mockResolvedValue({ ...settings }),
      save: jest.fn().mockImplementation((s) => Promise.resolve(s)),
    };
    const service = new TeamsService(
      null as never,
      membershipRepo as never,
      settingsRepo as never,
      null as never,
      null as never,
    );
    return { service, settingsRepo };
  }

  it('발언+출석 가중치 합이 1.0이면 정상 저장된다', async () => {
    const { service, settingsRepo } = makeService();
    const dto: UpdateTeamSettingsDto = {
      weight_speech_in_meeting: 0.7,
      weight_attend_in_meeting: 0.3,
    };
    await service.updateSettings(1, 1, dto);
    expect(settingsRepo.save).toHaveBeenCalled();
  });

  it('발언+출석 가중치 합이 1.0이 아니면 BadRequestException', async () => {
    const { service } = makeService();
    const dto: UpdateTeamSettingsDto = {
      weight_speech_in_meeting: 0.6,
      weight_attend_in_meeting: 0.6,
    };
    await expect(service.updateSettings(1, 1, dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('발언 가중치만 바꿔도(출석은 기존값 유지) 합이 깨지면 거부된다', async () => {
    // 기존 발언 0.6/출석 0.4 에서 발언만 0.9로 바꾸면 합이 1.3이 되어야 함
    const { service } = makeService();
    const dto: UpdateTeamSettingsDto = { weight_speech_in_meeting: 0.9 };
    await expect(service.updateSettings(1, 1, dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('지각 최대 인정 시간이 지각 기준보다 작으면 BadRequestException', async () => {
    const { service } = makeService();
    const dto: UpdateTeamSettingsDto = {
      late_threshold_minutes: 10,
      late_max_minutes: 5,
    };
    await expect(service.updateSettings(1, 1, dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('지각 최대 인정 시간이 0(상한 없음)이면 기준보다 작아도 허용된다', async () => {
    const { service, settingsRepo } = makeService();
    const dto: UpdateTeamSettingsDto = {
      late_threshold_minutes: 10,
      late_max_minutes: 0,
    };
    await service.updateSettings(1, 1, dto);
    expect(settingsRepo.save).toHaveBeenCalled();
  });
});
