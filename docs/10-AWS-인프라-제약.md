# 10. AWS 인프라 & 제약

본 프로젝트는 **Start AWS 학생 활동 프로그램**으로 운영되며, 사용 가능 서비스·인스턴스 타입·권한이 제한된다. 이 문서는 그 제약과 **우리 적용 사항**을 정리한다.

## 사용 가능 서비스 (이외 사용 금지)

| 서비스 | 우리 용도 |
| --- | --- |
| **EC2** (t3.nano ~ t3.small) | NestJS 서버 + (필요 시) 보조 컨테이너 |
| **RDS** (MySQL/postgres 프리티어) | MySQL — 회의·발화·기여도 영구 저장 |
| **S3** | **액션 아이템 첨부 파일 저장** (Presigned URL 업로드) + (옵션) 정리 리포트·DB 백업 |
| **Lambda** | (사용 안 함 — 회의 후 GPT-4o-mini 호출은 NestJS 서버 내 직접 처리, 2026-05-29 결정) |
| **DynamoDB** | (사용 안 함 — MySQL로 충분) |
| **API Gateway** | (옵션) WSS가 꼭 필요할 때 WebSocket API |
| **Amplify** | (옵션) 웹 프론트 정적 호스팅 — 기본안은 EC2의 Caddy가 정적 빌드를 서빙하므로 미사용, 분리 호스팅 시 후보 |
| **SQS / SNS** | (옵션) 회의 후 분석 큐 |
| **Bedrock** (us-east-1 / us-east-2 / us-west-1 / us-west-2) | (옵션) OpenAI 대신 Claude 등 사용 시 |

## 사용 불가 서비스 → 우리 대안

| 막힌 서비스 | 우리 대안 |
| --- | --- |
| **Cognito** | 카카오 OAuth + 백엔드 자체 JWT ([02-기능-명세](02-기능-명세.md) §인증) |
| **Route 53 / ACM** | 웹앱은 **HTTPS 필수**(getUserMedia·Web Speech API). 외부 등록처에서 도메인 발급 후 **EC2의 Caddy + Let's Encrypt로 자동 TLS** (ACM 없이). `https://` 정적 서빙 + `wss://` 프록시 |
| **CloudFront** | 기본 불필요 — 단일 EC2의 Caddy가 정적 프론트를 직접 서빙. 트래픽·캐싱 필요 시 재검토(옵션) |
| **ElastiCache** | NestJS 프로세스 **인메모리 Map** + 5초마다 RDS flush ([01-아키텍처](01-아키텍처.md) §데이터 흐름) |
| **ELB / Auto Scaling / DB Cluster** | 단일 EC2 + 단일 RDS. 4인 이하 팀, 회의 단위 트래픽이라 불필요 |
| **VPC 커스텀 (Private Subnet, NAT, Endpoint)** | 기본 VPC + Public Subnet + Security Group |
| **EKS / MSK** | EC2 위 `docker compose`로 NestJS 운영. 큐가 필요하면 SQS |
| **Grafana / Prometheus** | EC2 stdout → CloudWatch Logs |
| **GitHub Actions Access Key 기반 배포** | **수동 배포**: `git pull && docker compose up -d --build`. IAM Role이 필요하면 EC2 인스턴스 프로필 사용 |
| **Bedrock Fine tuning / Provisioned Throughput** | 사용 안 함. OpenAI GPT-4o-mini On-demand로 충분 (회의당 안건 수 + 2회 수준) |

## 운영 규칙

### 리전

- 기본: **서울 (ap-northeast-2)**
- Bedrock 쓸 경우: **us-east-1** 권장 (그 외 us-east-2 / us-west-1 / us-west-2도 가능)

### EC2

- 인스턴스 타입: **t3.small** (NestJS + 인메모리 캐시 운영용)
  - 처음엔 t3.nano/micro로 시작하고 메모리 부족 시 small로 승급해도 됨
- **인스턴스 프로필 필수**: `SafeInstanceProfileForUser-{username}`
- 보안 그룹: 생성 시 모든 허용 규칙 해제 → 인스턴스 생성 후 ingress rule 추가
  - 22 (SSH) — 본인 IP만
  - 80 (HTTP→HTTPS 리다이렉트 + Let's Encrypt 갱신) — 0.0.0.0/0
  - 443 (HTTPS/WSS, Caddy) — 0.0.0.0/0
  - NestJS(3000)는 외부 비노출 — Caddy가 내부에서 프록시

### 도메인·HTTPS (웹앱)

- 웹 MVP는 `getUserMedia`·Web Speech API가 **보안 컨텍스트(HTTPS)** 를 요구하므로 HTTPS가 필수다(localhost 예외).
- ACM/Route 53은 막혀 있으므로 **외부 등록처에서 도메인을 발급**받고 EC2의 **Caddy + Let's Encrypt**로 자동 TLS를 적용한다.
- Caddy가 한 EC2에서 ① 정적 프론트(React 빌드) 서빙 ② `wss://` → NestJS WebSocket 프록시 ③ `/api` → NestJS 프록시를 모두 담당한다.
- 도메인 발급·DNS 운영 주체는 추후 확정([09](09-미결정-사항.md)).

### RDS

- 엔진: **MySQL** (프리티어 템플릿)
- **생성 시 EC2 연결 X, 퍼블릭 액세스 허용**
- 접근 제어: RDS 보안 그룹의 3306 포트를 EC2 보안 그룹에만 열기
- 사용자별 누적 글자수는 RDS에 영구 저장 (캐시는 인메모리)

### Lambda (사용할 경우)

- 함수 생성 시 **새 역할 X**, 기존 역할 `SafeRoleForUser-{username}` 선택
- 최초 생성 직후 5초 정도 지연 — 새로고침 후 정상 접근

### S3 (액션 첨부 파일 저장)

- 버킷 이름은 **`{username}-...`** 로 시작 (예: `2026-inha-cc-15-backup`)
- 업로드 방식: **Presigned URL** — NestJS가 발급, 클라이언트가 S3에 직접 업로드 (서버 대역폭 절약)
- 허용 형식: **문서(PDF/doc/docx/xls/ppt) + 이미지(png/jpg), 파일당 10MB** (2026-05-29 결정)
- 접근: EC2 인스턴스 프로필(`SafeInstanceProfileForUser-{username}`)로 SDK 권한

### Access Key

- **발급 불가**. EC2에서 AWS SDK가 필요하면 **인스턴스 프로필**(`SafeInstanceProfileForUser-{username}`)로 권한을 받는다.
- 로컬 개발 시에는 AWS SDK 호출 자체를 피하거나, 더미 모드를 둔다.

### 환경 변수 / 시크릿

- OpenAI API 키, 카카오 클라이언트 시크릿, DB 패스워드 등은 EC2 안 `.env` 파일에 둔다 (**2026-05-29 확정**).
- Secrets Manager / SSM Parameter Store는 사용하지 않는다 (MVP·4인 팀 규모에 `.env`로 충분). 향후 필요 시 재검토.

## 배포 흐름

```
1. 개발자가 main에 머지 (PR 머지)
2. EC2에 SSH 접속
3. cd ~/app && git pull
4. docker compose up -d --build   # NestJS 재빌드·재기동
5. docker compose logs -f nest    # 로그 확인
```

- 1초 끊김은 학기 프로젝트 평가에 영향 없음 (제약 안내 원문 참조).
- 무중단이 필요해지면 그때 재검토.

## 의도적으로 도입하지 않는 것 (You Are Not Google)

| 항목 | 이유 |
| --- | --- |
| Auto Scaling | 4인 이하 팀의 회의 트래픽으로 스케일 이슈 없음 |
| ELB | EC2 1대에 LB 불필요. WSS 필요 시 API Gateway WebSocket으로 대체 가능 |
| ElastiCache | 인메모리 Map으로 충분, 영구화는 RDS flush로 |
| CloudFront | 단일 EC2의 Caddy가 정적 프론트를 직접 서빙. 학기 프로젝트 트래픽에 CDN 불필요 |
| Cognito | 카카오 로그인이라 직접 JWT 발급이 더 단순 |
| GitHub Actions CI/CD | Access Key 발급 불가, 수동 배포 ROI가 더 좋음 |

## 권한 추가가 필요해질 때

- Start AWS Slack의 **#999-general-tech-qna** 채널에 문의
- 단, 모든 요청이 승인되는 것은 아님

## 비용 가이드 (학생 활동 프로그램 무료 한도 내)

- EC2 t3.small: 프리티어 외 — 활동 프로그램 크레딧 사용
- RDS db.t3.micro 프리티어: 첫 12개월 750시간 무료
- 외부 OpenAI 비용: 회의당 GPT-4o-mini 호출 = 안건 수(안건별 요약) + 2회(회의 후 종합 정리·다음 회의 아젠다 생성). 안건 5개 가정 시 ~7회
  - `o200k_base` 토크나이저 측정 기준 회의당 약 **6,000~13,000토큰**, 비용 **약 $0.0015~0.0024** (별도 결제)
  - 기존 2회 호출 방식 대비 토큰 약 2.2~2.5배

## 참고

- 본 제약은 Start AWS 활동 프로그램 시작 가이드 기준. 변경 시 본 문서를 갱신한다.
