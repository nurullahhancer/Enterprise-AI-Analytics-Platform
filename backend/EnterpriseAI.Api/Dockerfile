FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish EnterpriseAI.Api/EnterpriseAI.Api.csproj -c Release -o /out

FROM build AS test
CMD ["dotnet", "test", "EnterpriseAIAnalytics.sln", "--configuration", "Release"]

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /out .
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser
EXPOSE 8080
ENTRYPOINT ["dotnet", "EnterpriseAI.Api.dll"]
