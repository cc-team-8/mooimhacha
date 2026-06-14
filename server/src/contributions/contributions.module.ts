import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContributionScore } from '../entities/contribution-score.entity';
import { Meeting } from '../entities/meeting.entity';
import { Agenda } from '../entities/agenda.entity';
import { Utterance } from '../entities/utterance.entity';
import { PresenceEvent } from '../entities/presence-event.entity';
import { AnomalyEvent } from '../entities/anomaly-event.entity';
import { ActionItem } from '../entities/action-item.entity';
import { TeamMembership } from '../entities/team-membership.entity';
import { TeamSettings } from '../entities/team-settings.entity';
import { User } from '../entities/user.entity';
import { TeamsModule } from '../teams/teams.module';
import { ContributionsController } from './contributions.controller';
import { ContributionsService } from './contributions.service';
import { ContributionClient } from './contribution.client';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ContributionScore,
      Meeting,
      Agenda,
      Utterance,
      PresenceEvent,
      AnomalyEvent,
      ActionItem,
      TeamMembership,
      TeamSettings,
      User,
    ]),
    TeamsModule,
  ],
  controllers: [ContributionsController],
  providers: [ContributionsService, ContributionClient],
  exports: [ContributionsService],
})
export class ContributionsModule {}
