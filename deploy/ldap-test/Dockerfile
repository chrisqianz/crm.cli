# P6 test directory: osixia/openldap + an ACL granting the CRM
# service account (cn=crm-service,ou=people) read access to the tree —
# the default ACL only allows self-read, which would hide every user
# from the service account.
FROM osixia/openldap:latest
COPY 99-service-acl.ldif /container/service/slapd/assets/config/bootstrap/ldif/99-service-acl.ldif
