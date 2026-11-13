# MinIO RELEASE.2025-02-03T21-03-04Z-cpuv1 reconstruída das camadas da imagem salva
# (minio-RELEASE...-cpuv1.tar). A tag saiu do Docker Hub, então não dá para dar pull.
# ADD extrai cada layer*.tar.gz na raiz, na mesma ordem do manifest original.
FROM scratch
ADD layer1.tar.gz /
ADD layer2.tar.gz /
ADD layer3.tar.gz /
ADD layer4.tar.gz /
ADD layer5.tar.gz /
ADD layer6.tar.gz /
ADD layer7.tar.gz /
ADD layer8.tar.gz /
ADD layer9.tar.gz /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    MINIO_ACCESS_KEY_FILE=access_key \
    MINIO_SECRET_KEY_FILE=secret_key \
    MINIO_ROOT_USER_FILE=access_key \
    MINIO_ROOT_PASSWORD_FILE=secret_key \
    MINIO_KMS_SECRET_KEY_FILE=kms_master_key \
    MINIO_UPDATE_MINISIGN_PUBKEY=RWTx5Zr1tiHQLwG9keckT0c45M3AGeHD6IvimQHpyRywVWGbP1aVSGav \
    MINIO_CONFIG_ENV_FILE=config.env \
    MC_CONFIG_DIR=/tmp/.mc
EXPOSE 9000
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["minio"]
