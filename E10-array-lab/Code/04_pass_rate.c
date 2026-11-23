#include <stdio.h>

int main(void)
{
    int a[20];
    int n, i;
    int gt = 0, ge = 0;

    scanf("%d", &n);
    for (i = 0; i < n; i++) {
        scanf("%d", &a[i]);
    }

    for (i = 0; i < n; i++) {
        if (a[i] > 60)  gt++;
        if (a[i] >= 60) ge++;
    }

    printf("及格人数（ > 60） = %d\n", gt);
    printf("及格人数（>= 60） = %d\n", ge);

    return 0;
}
