FROM azul/zulu-openjdk:25-latest AS build

RUN apt-get update -y && apt-get install -y maven
WORKDIR /build
COPY pom.xml ./
RUN mvn -B dependency:go-offline

COPY src ./src
RUN mvn -B package

FROM azul/zulu-openjdk:25-latest

WORKDIR /app
COPY --from=build /build/target/r2bench-1.0-SNAPSHOT.jar /app/r2bench.jar

EXPOSE 8080
ENTRYPOINT ["java", "-Dnetworkaddress.cache.ttl=-1", "-jar", "/app/r2bench.jar"]
