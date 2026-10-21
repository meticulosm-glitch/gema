{{- define "geolibre.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "geolibre.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "geolibre.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Valore di una variabile d'ambiente dell'app, come la vede il container: extraEnv vince su env.
Uso: include "gema.env" (list . "NOME" "default")
*/}}
{{- define "gema.env" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $val := index . 2 -}}
{{- range $root.Values.env }}{{ if eq .name $name }}{{ $val = .value }}{{ end }}{{ end -}}
{{- range $root.Values.extraEnv }}{{ if eq .name $name }}{{ $val = .value }}{{ end }}{{ end -}}
{{- $val -}}
{{- end -}}

{{/* Workspace GeoServer della configurazione: lo stesso per l'app e per il Job. */}}
{{- define "gema.configWorkspace" -}}
{{- include "gema.env" (list . "CONFIG_WORKSPACE" "mapp") -}}
{{- end -}}

{{/* Nomi delle risorse del Job, legati al rilascio (due installazioni nello stesso namespace non si scontrano). */}}
{{- define "gema.configInitName" -}}
{{- printf "%s-config-init" (include "geolibre.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "gema.configDbSecret" -}}
{{- printf "%s-config-db" (include "geolibre.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "gema.configGeoserverSecret" -}}
{{- printf "%s-config-geoserver" (include "geolibre.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Ruolo GeoServer di un ruolo Keycloak (plugin OIDC): ROLE_ + nome in maiuscolo. */}}
{{- define "gema.geoserverRole" -}}
{{- printf "ROLE_%s" (. | trim | upper) -}}
{{- end -}}

{{/*
Ruoli GeoServer che leggono la configurazione: configJob.aclReadRoles, oppure quelli dei ruoli dell'app
(VIEWER_ROLE, ADMIN_ROLE e KNOWN_ROLES), con gli stessi default di 40-runtime-config.sh.
*/}}
{{- define "gema.aclReadRoles" -}}
{{- if .Values.configJob.aclReadRoles -}}
{{- .Values.configJob.aclReadRoles -}}
{{- else -}}
{{- $roles := list (include "gema.env" (list . "VIEWER_ROLE" "fss-etl-viewer")) (include "gema.env" (list . "ADMIN_ROLE" "fss-etl-admin")) -}}
{{- range splitList "," (include "gema.env" (list . "KNOWN_ROLES" "")) }}{{ $roles = append $roles . }}{{ end -}}
{{- $out := list -}}
{{- range $roles }}{{ if trim . }}{{ $out = append $out (include "gema.geoserverRole" .) }}{{ end }}{{ end -}}
{{- uniq $out | join "," -}}
{{- end -}}
{{- end -}}

{{/* Ruoli GeoServer che scrivono la configurazione: configJob.aclWriteRoles, oppure quello di ADMIN_ROLE. */}}
{{- define "gema.aclWriteRoles" -}}
{{- if .Values.configJob.aclWriteRoles -}}
{{- .Values.configJob.aclWriteRoles -}}
{{- else -}}
{{- include "gema.geoserverRole" (include "gema.env" (list . "ADMIN_ROLE" "fss-etl-admin")) -}}
{{- end -}}
{{- end -}}

{{/* Etichette dei pod del Job: diverse da quelle del Deployment, così il Service non li seleziona. */}}
{{- define "gema.configInitLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}-config-init
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: config-init
{{- end -}}
