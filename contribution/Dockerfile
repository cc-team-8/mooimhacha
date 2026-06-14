# 기여도 산정 엔진 (cc-team-8/Contribution) — FastAPI 서버
#
# 우리 백엔드(NestJS)가 /pipeline/score 로 호출하는 외부 산정 API.
# 코드는 별도 저장소라 빌드 시 clone 한다(서브모듈 대신 단순 clone).
# 엔진 갱신 시 캐시 무효화: docker compose build --no-cache contribution
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

# 엔진 소스 (pyproject 의 런타임 의존성은 fastapi, uvicorn 뿐 — 직접 설치)
RUN git clone --depth 1 https://github.com/cc-team-8/Contribution.git . \
  && pip install --no-cache-dir "fastapi>=0.111" "uvicorn>=0.29"

EXPOSE 8000

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
